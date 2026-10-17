[CmdletBinding()]
param(
    [string]$ProjectPath = 'C:\health-compass',
    [switch]$SyncExpoPlugins
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = Split-Path -Parent $PSScriptRoot
$projectDirectory = [System.IO.Path]::GetFullPath($ProjectPath)
if ($projectDirectory -match '[^\x00-\x7F]') {
    throw 'ProjectPath must be an ASCII directory or junction for Windows native builds.'
}
Get-Command node -ErrorAction Stop | Out-Null

function Get-CanonicalDirectory([string]$Directory) {
    # Base64 keeps the real Unicode path intact in Windows PowerShell's native output handling.
    $encodedPath = & node --eval "process.stdout.write(Buffer.from(require('node:fs').realpathSync(process.argv[1]), 'utf8').toString('base64'))" $Directory
    if ($LASTEXITCODE -ne 0) { throw "Cannot resolve project directory: $Directory" }
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedPath))
}

function Replace-Once([string]$Text, [string]$Pattern, [string]$Replacement, [string]$Description) {
    $expression = [regex]::new($Pattern)
    if ($expression.Matches($Text).Count -ne 1) {
        throw "Expected one $Description in generated Android settings. Check the Expo template before building."
    }
    return $expression.Replace($Text, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $Replacement })
}

function Write-IfChanged([string]$Path, [string]$Text, [string]$Original) {
    $newline = if ($Original.Contains("`r`n")) { "`r`n" } else { "`n" }
    $outputText = $Text.Replace("`n", $newline)
    if ($outputText -cne $Original) {
        [System.IO.File]::WriteAllText($Path, $outputText, [System.Text.UTF8Encoding]::new($false))
    }
}

$sourceCanonical = Get-CanonicalDirectory $sourceDirectory
$projectItem = Get-Item -LiteralPath $projectDirectory -Force -ErrorAction SilentlyContinue
if ($null -eq $projectItem) {
    New-Item -ItemType Junction -Path $projectDirectory -Value $sourceCanonical | Out-Null
}
elseif (-not $projectItem.PSIsContainer) {
    throw "ProjectPath is not a directory: $projectDirectory"
}
$projectCanonical = Get-CanonicalDirectory $projectDirectory
if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($sourceCanonical, $projectCanonical)) {
    throw "ProjectPath points to a different project. Existing directory or junction was left untouched: $projectDirectory"
}

$androidDirectory = Join-Path $projectDirectory 'android'
$autolinkingScript = Join-Path $projectDirectory 'scripts\autolinking-ascii.mjs'
if (-not (Test-Path -LiteralPath $autolinkingScript -PathType Leaf)) {
    throw "Autolinking wrapper is missing: $autolinkingScript"
}
$originalNodeOptions = $env:NODE_OPTIONS
$originalCi = $env:CI
$originalExpoNoDotenv = $env:EXPO_NO_DOTENV
$originalAiEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    if ($entry.Key.StartsWith('EXPO_PUBLIC_AI_', [StringComparison]::OrdinalIgnoreCase)) {
        $originalAiEnvironment[$entry.Key] = $entry.Value
    }
}
try {
    $env:EXPO_NO_DOTENV = '1'
    foreach ($name in $originalAiEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    if ($env:NODE_OPTIONS -notmatch '(^|\s)--preserve-symlinks(\s|$)') {
        $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --preserve-symlinks".Trim()
    }
    if (-not (Test-Path -LiteralPath $androidDirectory -PathType Container) -or $SyncExpoPlugins) {
        $keystorePath = Join-Path $androidDirectory 'app\debug.keystore'
        $keystoreHash = if (Test-Path -LiteralPath $keystorePath) { (Get-FileHash -LiteralPath $keystorePath -Algorithm SHA256).Hash } else { $null }
        $expoCli = Join-Path $projectDirectory 'node_modules\expo\bin\cli'
        if (-not (Test-Path -LiteralPath $expoCli -PathType Leaf)) {
            throw 'Expo CLI is missing. Install project dependencies with npm ci first.'
        }
        $env:CI = '1'
        Push-Location -LiteralPath $projectDirectory
        try {
            $ErrorActionPreference = 'Continue'
            try {
                $prebuildArgs = @('--platform', 'android', '--no-install', '--no-clean', '--skip-dependency-update', 'react-native,react')
                & node $expoCli prebuild @prebuildArgs 2>&1 |
                    ForEach-Object { $_.ToString() }
                $prebuildExitCode = $LASTEXITCODE
            }
            finally { $ErrorActionPreference = 'Stop' }
            if ($prebuildExitCode -ne 0) { throw "Expo Android prebuild failed with exit code $prebuildExitCode." }
        }
        finally { Pop-Location }
        if ($keystoreHash -and (Get-FileHash -LiteralPath $keystorePath -Algorithm SHA256).Hash -ne $keystoreHash) {
            throw 'Expo prebuild changed the existing Android test keystore. Stop before packaging to preserve upgrade compatibility.'
        }
    }
    $settingsPath = Join-Path $androidDirectory 'settings.gradle'
    $propertiesPath = Join-Path $androidDirectory 'gradle.properties'
    $gradleWrapper = Join-Path $androidDirectory 'gradlew.bat'
    foreach ($requiredPath in @($settingsPath, $propertiesPath, $gradleWrapper)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Generated Android project is incomplete: $requiredPath"
        }
    }

    $originalSettings = [System.IO.File]::ReadAllText($settingsPath)
    $settings = $originalSettings.Replace("`r`n", "`n")
    $autolinkingPatch = @'
    // health-compass:ascii-autolinking:start
    ex.autolinkLibrariesFromCommand(
      ["node", new File(rootDir, "../scripts/autolinking-ascii.mjs").absolutePath, rootDir.parentFile.absolutePath] + expoAutolinking.rnConfigCommand,
      rootDir.parentFile,
      files("../package-lock.json", "../package.json", "settings.gradle", "../scripts/autolinking-ascii.mjs")
    )
    // health-compass:ascii-autolinking:end
'@
    $legacyAutolinking = @'
    ex.autolinkLibrariesFromCommand(
      ["node", new File(rootDir, "autolinking-ascii.mjs").absolutePath, rootDir.parentFile.absolutePath] + expoAutolinking.rnConfigCommand,
      rootDir.parentFile,
      files("../package-lock.json", "../package.json", "settings.gradle", "autolinking-ascii.mjs")
    )
'@
    $autolinkingMarker = '(?ms)^    // health-compass:ascii-autolinking:start\n.*?^    // health-compass:ascii-autolinking:end'
    if ([regex]::IsMatch($settings, $autolinkingMarker)) {
        $settings = Replace-Once $settings $autolinkingMarker $autolinkingPatch 'managed autolinking block'
    }
    elseif ($settings.Contains($legacyAutolinking)) {
        $settings = Replace-Once $settings ([regex]::Escape($legacyAutolinking)) $autolinkingPatch 'legacy autolinking block'
    }
    else {
        $templateAutolinking = '    ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)'
        $settings = Replace-Once $settings ([regex]::Escape($templateAutolinking)) $autolinkingPatch 'Expo autolinking command'
    }

    $directoryPatch = @'
// health-compass:ascii-project-directories:start
// Windows native tools cannot reliably encode canonical Unicode paths in generated headers.
def canonicalProjectRoot = new File(providers.exec {
  workingDir(rootDir)
  commandLine("node", "-e", "process.stdout.write(require('fs').realpathSync(process.argv[1]))", rootDir.parentFile.absolutePath)
}.standardOutput.asText.get().trim()).toPath()
def aliasProjectRoot = rootDir.parentFile.toPath()
def mapProjectDirectories
mapProjectDirectories = { descriptor ->
  def source = descriptor.projectDir.toPath()
  if (source.startsWith(canonicalProjectRoot)) {
    descriptor.projectDir = aliasProjectRoot.resolve(canonicalProjectRoot.relativize(source)).toFile()
  }
  descriptor.children.each { mapProjectDirectories(it) }
}
mapProjectDirectories(rootProject)
// health-compass:ascii-project-directories:end
'@
    $directoryMarker = '(?ms)^// health-compass:ascii-project-directories:start\n.*?^// health-compass:ascii-project-directories:end'
    $legacyDirectory = '(?ms)^// Windows native tools cannot reliably encode canonical Unicode paths in generated headers\.\n.*?^mapProjectDirectories\(rootProject\)'
    if ([regex]::IsMatch($settings, $directoryMarker)) {
        $settings = Replace-Once $settings $directoryMarker $directoryPatch 'managed project directory block'
    }
    elseif ([regex]::IsMatch($settings, $legacyDirectory)) {
        $settings = Replace-Once $settings $legacyDirectory $directoryPatch 'legacy project directory block'
    }
    else {
        $modulesCommand = 'expoAutolinking.useExpoModules()'
        $settings = Replace-Once $settings ([regex]::Escape($modulesCommand)) "$modulesCommand`n`n$directoryPatch" 'Expo modules command'
    }

    $originalProperties = [System.IO.File]::ReadAllText($propertiesPath)
    $properties = $originalProperties.Replace("`r`n", "`n")
    $jvmArguments = [regex]::Match($properties, '(?m)^org\.gradle\.jvmargs=(.*)$')
    if ($jvmArguments.Success) {
        $arguments = [regex]::Replace($jvmArguments.Groups[1].Value, '(^|\s)-Dfile\.encoding=\S+', '').Trim()
        $properties = Replace-Once $properties '(?m)^org\.gradle\.jvmargs=.*$' "org.gradle.jvmargs=$arguments -Dfile.encoding=UTF-8" 'Gradle JVM arguments'
    }
    else {
        $properties = $properties.TrimEnd() + "`norg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8`n"
    }
    Write-IfChanged $settingsPath $settings $originalSettings
    Write-IfChanged $propertiesPath $properties $originalProperties

    $appGradlePath = Join-Path $androidDirectory 'app\build.gradle'
    $originalAppGradle = [System.IO.File]::ReadAllText($appGradlePath)
    $appGradle = $originalAppGradle.Replace("`r`n", "`n")
    $bundlePatch = @'
// health-compass:fresh-bundle:start
// Environment values are not Gradle task inputs; always rebuild the standalone JS bundle.
tasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach {
    outputs.upToDateWhen { false }
    outputs.doNotCacheIf('Standalone bundle must use the current build environment') { true }
}
// health-compass:fresh-bundle:end
'@
    $bundleMarker = '(?ms)^// health-compass:fresh-bundle:start\n.*?^// health-compass:fresh-bundle:end'
    if ([regex]::IsMatch($appGradle, $bundleMarker)) {
        $appGradle = Replace-Once $appGradle $bundleMarker $bundlePatch 'managed fresh bundle block'
    }
    else { $appGradle = $appGradle.TrimEnd() + "`n`n$bundlePatch`n" }
    Write-IfChanged $appGradlePath $appGradle $originalAppGradle

    $manifestPath = Join-Path $androidDirectory 'app\src\main\AndroidManifest.xml'
    $manifest = [System.Xml.XmlDocument]::new()
    $manifest.PreserveWhitespace = $true
    $manifest.Load($manifestPath)
    $application = $manifest.SelectSingleNode('/manifest/application')
    if ($null -eq $application) { throw 'Generated Android manifest has no application element.' }
    $androidNamespace = 'http://schemas.android.com/apk/res/android'
    if ($application.GetAttribute('usesCleartextTraffic', $androidNamespace) -ne 'false') {
        $application.SetAttribute('usesCleartextTraffic', $androidNamespace, 'false') | Out-Null
        $writerSettings = [System.Xml.XmlWriterSettings]::new()
        $writerSettings.Encoding = [System.Text.UTF8Encoding]::new($false)
        $writerSettings.OmitXmlDeclaration = $true
        $writer = [System.Xml.XmlWriter]::Create($manifestPath, $writerSettings)
        try { $manifest.Save($writer) } finally { $writer.Dispose() }
    }
    Write-Output "Android project prepared: $androidDirectory"
}
finally {
    $env:NODE_OPTIONS = $originalNodeOptions
    $env:CI = $originalCi
    $env:EXPO_NO_DOTENV = $originalExpoNoDotenv
    foreach ($name in $originalAiEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalAiEnvironment[$name], 'Process') }
}
