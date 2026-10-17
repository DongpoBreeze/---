[CmdletBinding()]
param(
    [string]$ProjectPath = 'C:\health-compass',
    [string]$AndroidSdkPath = '',
    [string]$Architectures = 'arm64-v8a'
)

$ErrorActionPreference = 'Stop'
if ($Architectures -notmatch '^(arm64-v8a|armeabi-v7a|x86|x86_64)(,(arm64-v8a|armeabi-v7a|x86|x86_64))*$') {
    throw 'Architectures must be a comma-separated list of supported Android ABIs.'
}
if (-not $AndroidSdkPath) {
    $AndroidSdkPath = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
        elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
        else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
}
$sdkDirectory = (Resolve-Path -LiteralPath $AndroidSdkPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $sdkDirectory 'platform-tools'))) {
    throw "Android SDK platform-tools directory is missing: $sdkDirectory"
}
& (Join-Path $PSScriptRoot 'prepare-android.ps1') -ProjectPath $ProjectPath -SyncExpoPlugins
$projectDirectory = (Resolve-Path -LiteralPath $ProjectPath).Path
$androidDirectory = Join-Path $projectDirectory 'android'
$gradleWrapper = Join-Path $androidDirectory 'gradlew.bat'
if (-not (Test-Path -LiteralPath $gradleWrapper -PathType Leaf)) {
    throw "Android Gradle wrapper is missing after preparation: $gradleWrapper"
}
$artifactDirectory = Join-Path $projectDirectory 'artifacts'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$buildTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDirectory "android-release-$buildTag.log"
$originalAndroidHome = $env:ANDROID_HOME
$originalSdkRoot = $env:ANDROID_SDK_ROOT
$originalNodeEnv = $env:NODE_ENV
$originalNodeOptions = $env:NODE_OPTIONS
$originalExpoNoDotenv = $env:EXPO_NO_DOTENV
$originalAiEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    if ($entry.Key.StartsWith('EXPO_PUBLIC_AI_', [StringComparison]::OrdinalIgnoreCase)) {
        $originalAiEnvironment[$entry.Key] = $entry.Value
    }
}
$buildExitCode = 1
try {
    $env:ANDROID_HOME = $sdkDirectory
    $env:ANDROID_SDK_ROOT = $sdkDirectory
    $env:NODE_ENV = 'production'
    # Release APKs are standalone and must never inherit developer dotenv/client settings.
    $env:EXPO_NO_DOTENV = '1'
    foreach ($name in $originalAiEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    # Keep Node's dependency paths on the ASCII junction instead of canonicalizing to the Unicode path.
    if ($env:NODE_OPTIONS -notmatch '(^|\s)--preserve-symlinks(\s|$)') {
        $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --preserve-symlinks".Trim()
    }
    Push-Location -LiteralPath $androidDirectory
    try {
        # Windows PowerShell converts native stderr into ErrorRecords; Gradle's exit code is authoritative.
        $ErrorActionPreference = 'Continue'
        try {
            $gradleArgs = @(':app:assembleRelease', '--no-daemon', '--console=plain', '--stacktrace', "-PreactNativeArchitectures=$Architectures")
            & $gradleWrapper @gradleArgs 2>&1 |
                ForEach-Object { $_.ToString() } |
                Tee-Object -FilePath $logPath
            $buildExitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = 'Stop' }
    }
    finally { Pop-Location }
}
finally {
    $env:ANDROID_HOME = $originalAndroidHome
    $env:ANDROID_SDK_ROOT = $originalSdkRoot
    $env:NODE_ENV = $originalNodeEnv
    $env:NODE_OPTIONS = $originalNodeOptions
    $env:EXPO_NO_DOTENV = $originalExpoNoDotenv
    foreach ($name in $originalAiEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalAiEnvironment[$name], 'Process') }
}
if ($buildExitCode -ne 0) {
    throw "Gradle release build failed with exit code $buildExitCode. Log: $logPath"
}
$apkPath = Join-Path $androidDirectory 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path -LiteralPath $apkPath)) {
    throw "Gradle succeeded without producing the expected APK: $apkPath"
}
$destination = Join-Path $artifactDirectory "health-compass-$($Architectures.Replace(',', '-'))-release-$buildTag.apk"
$latestDestination = Join-Path $artifactDirectory "health-compass-$($Architectures.Replace(',', '-'))-release.apk"
if (Test-Path -LiteralPath $latestDestination -PathType Leaf) {
    $preservedDestination = Join-Path $artifactDirectory "health-compass-$($Architectures.Replace(',', '-'))-release-previous-$buildTag.apk"
    Copy-Item -LiteralPath $latestDestination -Destination $preservedDestination
    Write-Output "Previous APK preserved: $preservedDestination"
}
Copy-Item -LiteralPath $apkPath -Destination $destination
Copy-Item -LiteralPath $apkPath -Destination $latestDestination -Force
$apkHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$destination.sha256", "$apkHash  $([System.IO.Path]::GetFileName($destination))`n", [System.Text.Encoding]::ASCII)
Write-Output "APK: $destination"
Write-Output "SHA256: $apkHash"
Write-Output "Build log: $logPath"
