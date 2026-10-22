import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BMI_SCALE, bmiSegmentMarkerRatio, bmiStatus, bmiWeightBreakpoints, calculateProfileHealth, formatBmiDisplay,
} from '../profile-health';
import type { Profile } from '../types';
import { space, type ThemeTokens } from './theme';
import { useTheme, useThemedStyles } from './theme-provider';

const weightLabel = (kg: number) => kg.toFixed(1);

function BmiScale({ current, target, heightCm }: { current: number | null; target: number | null; heightCm?: number }) {
  const { color } = useTheme();
  const st = useThemedStyles(createStyles);
  const [trackWidth, setTrackWidth] = useState(0);
  const breakpoints = bmiWeightBreakpoints(heightCm);
  const compact = trackWidth < 380;
  const lineBreak = compact ? '\n' : '';
  const ranges = breakpoints ? [
    `<${weightLabel(breakpoints[0])}`,
    `${weightLabel(breakpoints[0])}–${lineBreak}<${weightLabel(breakpoints[1])}`,
    `${weightLabel(breakpoints[1])}–${lineBreak}<${weightLabel(breakpoints[2])}`,
    `≥${weightLabel(breakpoints[2])}`,
  ] : ['<18.5', `18.5–${lineBreak}<24`, `24–${lineBreak}<28`, '≥28'];
  const segments = [
    { label: '偏瘦', color: color.sleep, text: color.sleepText },
    { label: '正常', color: color.training, text: color.trainingText },
    { label: '超重', color: color.meal, text: color.mealText },
    { label: '肥胖', color: color.danger, text: color.danger },
  ];
  const currentStatus = current === null ? null : bmiStatus(current);
  const markers = [
    { id: 'current', label: '当前 BMI', bmi: current, ratio: current === null ? null : bmiSegmentMarkerRatio(current), target: false },
    { id: 'target', label: '建议目标 BMI', bmi: target, ratio: target === null ? null : bmiSegmentMarkerRatio(target), target: true },
  ];
  return <View testID="profile-bmi-scale" style={st.scale}>
    <Text testID="profile-bmi-range-context" style={st.scaleContext}>
      {breakpoints ? `按 ${heightCm} cm 换算 · 体重约数（kg）` : 'BMI 分类 · 填写身高后换算体重'}
    </Text>
    <View style={st.categories}>
      {segments.map((segment, index) => <View key={segment.label} style={st.category}
        testID={`profile-bmi-category-${index}`}>
        <Text style={[st.categoryLabel, currentStatus === segment.label && { color: segment.text }]}>{segment.label}</Text>
        <Text testID={`profile-bmi-weight-range-${index}`} style={st.categoryRange}>{ranges[index]}</Text>
      </View>)}
    </View>
    <View testID="profile-bmi-track" style={st.scaleTrack}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}>
      <View style={st.band}>
        {segments.map((segment) => <View key={segment.label}
          style={[st.segment, { backgroundColor: segment.color }, currentStatus === segment.label && st.activeSegment]} />)}
      </View>
      {markers.map((marker) => {
        if (marker.ratio === null) return null;
        const width = marker.target ? 44 : 34;
        const position = marker.ratio * trackWidth;
        const left = Math.max(0, Math.min(position - width / 2, trackWidth - width));
        // Keep the rotated pointer's painted corners inside the track at both extremes.
        const pointerLeft = Math.max(2, Math.min(position - left - 4, width - 10));
        return <View key={marker.id} testID={`profile-bmi-${marker.id}-marker`}
          accessible accessibilityRole="image" accessibilityLabel={`${marker.label} ${formatBmiDisplay(marker.bmi!)}`}
          style={[st.marker, marker.target ? st.targetMarker : st.currentMarker, { left, width }]}>
          <View style={[st.markerPill, marker.target ? st.targetPill : st.currentPill]}>
            <Text style={[st.markerText, marker.target ? st.targetText : st.currentText]}>{marker.target ? '目标' : '你'}</Text>
          </View>
          <View style={[st.pointer, marker.target ? st.targetPointer : st.currentPointer, { left: pointerLeft }]} />
        </View>;
      })}
    </View>
    <View style={st.markerLegend}>
      {markers.map((marker) => <View key={marker.id} style={st.markerLegendItem}>
        <View style={[st.legendDot, marker.target ? st.legendTarget : st.legendCurrent]} />
        <Text style={st.markerDetail}>
          {marker.bmi === null ? marker.target ? '暂无建议目标' : '等待你的资料' : `${marker.label} ${formatBmiDisplay(marker.bmi)}`}
        </Text>
      </View>)}
    </View>
    <Text style={st.scaleNote}>
      {markers.some((marker) => marker.bmi !== null && (marker.bmi < BMI_SCALE.min || marker.bmi > BMI_SCALE.max))
        ? '超出刻度时标记停在边缘，数值保留实际值。'
        : '分段示意，分类以 BMI 为准。'}
    </Text>
  </View>;
}

export function ProfileHealthPanel({ profile }: { profile: Profile }) {
  const { color } = useTheme();
  const st = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(false);
  const [wide, setWide] = useState(false);
  const ref = calculateProfileHealth(profile);
  const bmiLabel = ref.bmi === null ? null : formatBmiDisplay(ref.bmi);
  const statusTone = ref.bmiStatus === '偏瘦' ? color.sleepText
    : ref.bmiStatus === '正常' ? color.trainingText
      : ref.bmiStatus === '超重' ? color.mealText : ref.bmiStatus === '肥胖' ? color.danger : color.inkSoft;
  const bmiFontSize = bmiLabel && bmiLabel.length > 5 ? 34 : bmiLabel && bmiLabel.length > 4 ? 40 : 52;
  return <View testID="profile-health-reference" style={[st.panel, wide && st.widePanel]}
    onLayout={(event) => setWide(event.nativeEvent.layout.width >= 560)}>
    <View style={st.panelHeader}>
      <Text style={st.cap}>BODY REFERENCE · 身体参考</Text>
      <Text style={st.localLabel}>本机计算</Text>
    </View>
    <Text testID="profile-age-reference" style={st.ageContext}>{ref.age.label}</Text>
    <View style={[st.overview, wide && ref.age.adultApplicable && st.overviewWide]}>
      <View style={[st.summary, wide && ref.age.adultApplicable && st.summaryWide]}>
        <View style={st.readingBlock}>
          <Text style={st.readingLabel}>当前 BMI</Text>
          <View testID="profile-bmi-reading" style={st.reading} accessibilityLiveRegion="polite">
            {bmiLabel === null ? <Text style={st.readingEmpty}>待补充</Text> : <>
              <Text testID="profile-bmi-number" style={[st.readingNumber, { fontSize: bmiFontSize }]}>{bmiLabel}</Text>
              <Text style={[st.readingStatus, { color: statusTone }]}>{` · ${ref.age.adultApplicable ? ref.bmiStatus : '需分龄解读'}`}</Text>
            </>}
          </View>
        </View>
        {ref.age.adultApplicable && <View style={[st.normalReference, wide && st.normalReferenceWide]}>
          <Text style={st.normalLabel}>此身高的正常体重</Text>
          {ref.normalWeightKg ? <Text testID="profile-normal-weight" style={st.normalValue}>
            {weightLabel(ref.normalWeightKg.min)}–{weightLabel(ref.normalWeightKg.max)} kg
          </Text> : <Text style={st.normalEmpty}>填写身高后显示</Text>}
          <Text style={st.normalCaption}>{ref.normalWeightKg ? `${profile.heightCm} cm · 成人参考` : '仅作普通成人参考'}</Text>
        </View>}
      </View>
      {ref.age.adultApplicable && <BmiScale current={ref.bmi} target={ref.weight.targetBmi} heightCm={profile.heightCm} />}
    </View>
    {ref.bodyReason && <Text style={st.emptyNote}>{ref.bodyReason}</Text>}
    {ref.age.adultApplicable && <View style={st.recommendations}>
      <View style={st.recommendation}>
        <Text style={st.recommendationLabel}>阶段体重建议</Text>
        <View testID="profile-weight-target" style={st.recommendationValue} accessibilityLiveRegion="polite">
          {ref.weight.targetKg === null ? <Text style={st.unavailable}>待补充或需单独评估</Text> : <>
            <Text testID="profile-weight-target-value" style={st.targetValue}>
              {weightLabel(ref.weight.targetKg)}<Text style={st.unit}> kg</Text>
            </Text>
            <Text testID="profile-weight-target-bmi" style={st.targetDetail}>
              BMI {formatBmiDisplay(ref.weight.targetBmi!)} · {ref.weight.targetStatus}
            </Text>
          </>}
        </View>
      </View>
      <View style={st.recommendation}>
        <Text style={st.recommendationLabel}>每日热量起始建议</Text>
        <Text testID="profile-calorie-recommendation" style={[st.targetValue, ref.calories.target === null && st.unavailable]}
          accessibilityLiveRegion="polite">
          {ref.calories.target === null ? '暂不自动推荐' : <>{ref.calories.target}<Text style={st.unit}> kcal/日</Text></>}
        </Text>
        {ref.calories.target !== null && <Text style={st.targetDetail}>可按实际变化调整</Text>}
      </View>
    </View>}
    {!ref.bodyReason && ref.weight.targetKg === null && <Text style={st.small}>{ref.weight.detail}</Text>}
    {!ref.bodyReason && ref.calories.target === null && <Text style={st.small}>{ref.calories.detail}</Text>}
    <View style={st.footer}>
      <Text style={st.basis}>{ref.age.adultApplicable ? '普通成人参考' : '需分龄解读'} · BMI 不等于体脂</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} aria-expanded={expanded}
        accessibilityLabel={expanded ? '收起计算依据' : '查看计算依据'}
        onPress={() => setExpanded(!expanded)} style={st.disclosure}>
        <Text style={st.disclosureText}>{expanded ? '收起依据 −' : '计算依据 +'}</Text>
      </Pressable>
    </View>
    {expanded && <View testID="profile-health-basis" style={st.referenceBlock}>
      <Text style={st.small}>BMI = 体重（kg）÷ 身高（m）的平方。年龄只用于判断本功能适用范围，性别不改变 BMI 公式；适用分组是产品约定，非临床阈值。</Text>
      {ref.age.adultApplicable ? <>
        <Text style={st.small}>按中国成人 BMI 阈值分类，使用未四舍五入值；通常显示 1 位小数，接近分类边界时增加至最多 3 位，仍会跨界则显示“&lt;阈值”。正常分类为 18.5 ≤ BMI &lt; 24；正常体重参考上沿按 BMI 23.9 换算，不表示 23.9–24 之间异常。</Text>
        <Text style={st.small}>四段横线为分类示意，体重分界按当前身高与 BMI 18.5、24、28 换算，显示值为约数。</Text>
        <Text style={st.small}>{ref.weight.detail}</Text>
        <Text style={st.small}>{ref.calories.detail}</Text>
        {ref.calories.formula && <Text style={st.small}>{ref.calories.formula}</Text>}
        <Text style={st.basis}>体重百分比是产品阶段参考。热量取已有 25–35 kcal/kg/日参考的中点，并非基础代谢或精确每日需要量；公式未按年龄、性别或活动量作个人化测算。BMI 不能区分肌肉与脂肪，孕哺期及有特殊健康状况者需单独评估。</Text>
      </> : <Text style={st.small}>当前仅显示 BMI 数值，不提供普通成人分类、正常体重区间、阶段体重、自动热量或备餐量建议。手动热量目标和逐菜填写实际食用量仍可使用。</Text>}
    </View>}
  </View>;
}

function createStyles({ color, type }: ThemeTokens) {
  return StyleSheet.create({
    panel: { minWidth: 0, borderRadius: 16, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface, padding: 16, gap: space.lg, marginBottom: space.md },
    widePanel: { padding: 20, gap: 20 },
    panelHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: space.xs },
    cap: { ...type.cap, fontSize: 9, letterSpacing: 1 },
    localLabel: { color: color.inkFaint, fontSize: 10, lineHeight: 14 },
    ageContext: { color: color.inkSoft, fontSize: 10.5, lineHeight: 17, marginTop: -space.sm },
    overview: { gap: 20 },
    overviewWide: { flexDirection: 'row', alignItems: 'flex-start', gap: 28 },
    summary: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
    summaryWide: { flexDirection: 'column', alignItems: 'stretch', width: 170, gap: space.lg },
    readingBlock: { flex: 1, minWidth: 0 },
    readingLabel: { color: color.inkSoft, fontSize: 11.5, lineHeight: 17 },
    reading: { alignItems: 'flex-start' },
    readingNumber: { ...type.mono, color: color.ink, lineHeight: 60, fontWeight: '800', letterSpacing: -2 },
    readingStatus: { fontSize: 13, lineHeight: 19, fontWeight: '700', marginLeft: -5 },
    readingEmpty: { fontSize: 26, lineHeight: 54, color: color.inkFaint, fontWeight: '700' },
    normalReference: { flex: 1, minWidth: 0, borderLeftWidth: 1, borderLeftColor: color.line, paddingLeft: space.md, gap: 3 },
    normalReferenceWide: { flex: 0, borderLeftWidth: 0, paddingLeft: 0 },
    normalLabel: { color: color.inkSoft, fontSize: 11, lineHeight: 17 },
    normalValue: { ...type.mono, color: color.ink, fontSize: 14, lineHeight: 22, fontWeight: '700' },
    normalEmpty: { color: color.inkSoft, fontSize: 12, lineHeight: 20 },
    normalCaption: { color: color.inkFaint, fontSize: 10, lineHeight: 15 },
    scale: { flex: 1, minWidth: 0 },
    scaleContext: { color: color.inkFaint, fontSize: 10, lineHeight: 16, marginBottom: space.md },
    categories: { flexDirection: 'row', gap: 5 },
    category: { flex: 1, minWidth: 0, alignItems: 'center' },
    categoryLabel: { color: color.inkSoft, fontSize: 12, lineHeight: 18, fontWeight: '700' },
    categoryRange: { ...type.mono, color: color.inkSoft, fontSize: 10.5, lineHeight: 15, minHeight: 30, textAlign: 'center', marginTop: 4 },
    scaleTrack: { height: 78, position: 'relative' },
    band: { position: 'absolute', top: 36, height: 5, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
    segment: { flex: 1, height: 3, borderRadius: 2, opacity: 0.65 },
    activeSegment: { height: 5, opacity: 1 },
    marker: { position: 'absolute', height: 24 },
    currentMarker: { top: 3 },
    targetMarker: { top: 52 },
    markerPill: { height: 23, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
    currentPill: { backgroundColor: color.ink },
    targetPill: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.inkSoft },
    markerText: { fontSize: 11, lineHeight: 16, fontWeight: '800' },
    currentText: { color: color.onInk },
    targetText: { color: color.inkSoft },
    pointer: { position: 'absolute', width: 8, height: 8, transform: [{ rotate: '45deg' }] },
    currentPointer: { top: 20, backgroundColor: color.ink },
    targetPointer: { top: -9, borderWidth: 1.5, borderColor: color.inkSoft, backgroundColor: color.surface },
    markerLegend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md, rowGap: space.xs },
    markerLegendItem: { flexDirection: 'row', gap: 5, alignItems: 'center', minWidth: 0, flexShrink: 1 },
    markerDetail: { color: color.inkSoft, fontSize: 10.5, lineHeight: 17, flexShrink: 1 },
    legendDot: { width: 6, height: 6, borderWidth: 1, borderColor: color.inkSoft },
    legendCurrent: { borderRadius: 3, backgroundColor: color.ink },
    legendTarget: { transform: [{ rotate: '45deg' }], backgroundColor: color.surface },
    scaleNote: { color: color.inkFaint, fontSize: 9.5, lineHeight: 15, marginTop: 5 },
    emptyNote: { color: color.inkSoft, fontSize: 11.5, lineHeight: 18, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.softSurface, borderRadius: 10 },
    recommendations: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    recommendation: { flex: 1, minWidth: 110, backgroundColor: color.softSurface, borderRadius: 12, padding: space.md, gap: 6 },
    recommendationLabel: { color: color.inkSoft, fontSize: 10.5, lineHeight: 17 },
    recommendationValue: { gap: 3 },
    targetValue: { ...type.mono, color: color.ink, fontSize: 22, lineHeight: 27, fontWeight: '800' },
    unit: { color: color.inkSoft, fontSize: 10.5, fontWeight: '500', letterSpacing: 0 },
    targetDetail: { ...type.mono, color: color.inkFaint, fontSize: 10, lineHeight: 16 },
    unavailable: { color: color.inkFaint, fontSize: 12, lineHeight: 20, fontWeight: '500' },
    small: { ...type.small, fontSize: 11.5, lineHeight: 18, flexShrink: 1 },
    footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: space.sm },
    basis: { color: color.inkFaint, fontSize: 10, lineHeight: 17, flexShrink: 1 },
    disclosure: { minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start' },
    disclosureText: { color: color.inkSoft, fontSize: 10.5, lineHeight: 18, fontWeight: '700' },
    referenceBlock: { paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line, gap: space.sm },
  });
}
