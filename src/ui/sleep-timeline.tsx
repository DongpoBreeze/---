import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { moveSleepTimeline, SLEEP_TIME_STEP_MINUTES, sleepClockLabel, sleepLocalTimeLabel, sleepTimelineTicks, type SleepTimeEndpoint, type SleepTimeline as TimelineModel } from '../sleep-time';
import { type ThemeTokens } from './theme';
import { useTheme, useThemedStyles } from './theme-provider';

type Selection = { fell: string; woke: string };

function TimeHandle({ endpoint, model, width, disabled, onChange, onDragStart, onDragEnd }: {
  endpoint: SleepTimeEndpoint;
  model: TimelineModel;
  width: number;
  disabled: boolean;
  onChange: (selection: Selection) => void;
  onDragStart: (model: TimelineModel) => void;
  onDragEnd: () => void;
}) {
  const { color } = useTheme();
  const st = useThemedStyles(createStyles);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ model, width, disabled, onChange, onDragStart, onDragEnd });
  latest.current = { model, width, disabled, onChange, onDragStart, onDragEnd };
  const drag = useRef<{ model: TimelineModel; width: number } | null>(null);
  const value = endpoint === 'fell' ? model.fellAt : model.wokeAt;
  const minutes = (model.axisEnd - model.axisStart) / 60000;
  const offset = (value - model.axisStart) / 60000;
  const applyDelta = (dx: number) => {
    const active = drag.current;
    const current = latest.current;
    if (!active || current.disabled || active.width <= 0) return;
    const originalTime = endpoint === 'fell' ? active.model.fellAt : active.model.wokeAt;
    const originalOffset = (originalTime - active.model.axisStart) / 60000;
    const nextOffset = originalOffset + dx / active.width * ((active.model.axisEnd - active.model.axisStart) / 60000);
    current.onChange(moveSleepTimeline(active.model, endpoint, nextOffset));
  };
  const finishDrag = () => {
    drag.current = null;
    setDragging(false);
    latest.current.onDragEnd();
  };
  const handlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !latest.current.disabled && latest.current.width > 0,
    onMoveShouldSetPanResponder: () => !latest.current.disabled && latest.current.width > 0,
    onPanResponderGrant: () => {
      const current = latest.current;
      drag.current = { model: current.model, width: current.width };
      setDragging(true);
      current.onDragStart(current.model);
    },
    onPanResponderMove: (_event, gesture) => applyDelta(gesture.dx),
    onPanResponderRelease: (_event, gesture) => { applyDelta(gesture.dx); finishDrag(); },
    onPanResponderTerminate: finishDrag,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), [endpoint]);
  useEffect(() => () => { drag.current = null; }, []);

  const adjust = (nextOffset: number) => {
    const current = latest.current;
    if (!current.disabled) current.onChange(moveSleepTimeline(current.model, endpoint, nextOffset));
  };
  const keyboardProps = Platform.OS === 'web' ? {
    onKeyDown: (event: React.KeyboardEvent) => {
      const increments: Record<string, number> = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -60, PageUp: 60 };
      let nextOffset: number;
      if (event.key in increments) nextOffset = offset + increments[event.key];
      else if (event.key === 'Home') nextOffset = 0;
      else if (event.key === 'End') nextOffset = minutes;
      else return;
      event.preventDefault();
      adjust(nextOffset);
    },
  } : {};
  return (
    <View
      {...handlers.panHandlers}
      {...keyboardProps}
      testID={`sleep-${endpoint}-slider`}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={endpoint === 'fell' ? '入睡时间滑块' : '起床时间滑块'}
      accessibilityHint="拖动选择时间，也可使用方向键每次调整五分钟。"
      accessibilityState={{ disabled }}
      accessibilityValue={{ min: 0, max: minutes, now: offset, text: sleepLocalTimeLabel(value) }}
      aria-disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={minutes}
      aria-valuenow={offset}
      aria-valuetext={sleepLocalTimeLabel(value)}
      accessibilityActions={[{ name: 'increment', label: '推迟五分钟' }, { name: 'decrement', label: '提前五分钟' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') adjust(offset + SLEEP_TIME_STEP_MINUTES);
        if (event.nativeEvent.actionName === 'decrement') adjust(offset - SLEEP_TIME_STEP_MINUTES);
      }}
      tabIndex={disabled ? -1 : 0}
      style={[st.handle, { left: `${offset / minutes * 100}%` }, disabled && st.disabled,
        Platform.OS === 'web' && ({ touchAction: 'none', userSelect: 'none', cursor: disabled ? 'default' : dragging ? 'grabbing' : 'grab' } as unknown as ViewStyle)]}
    >
      <View style={[st.thumb, dragging && st.thumbActive]}>
        <Ionicons name={endpoint === 'fell' ? 'moon' : 'sunny'} size={14} color={color.onSleep} />
      </View>
    </View>
  );
}

export function SleepTimeline({ model, disabled = false, onChange }: {
  model: TimelineModel;
  disabled?: boolean;
  onChange: (selection: Selection) => void;
}) {
  const st = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const [dragAxis, setDragAxis] = useState<TimelineModel | null>(null);
  // Keep the scale still during a drag, including nonstandard daytime records.
  const visible = dragAxis ? { ...model, axisStart: dragAxis.axisStart, axisEnd: dragAxis.axisEnd } : model;
  const start = (visible.fellAt - visible.axisStart) / (visible.axisEnd - visible.axisStart);
  const end = (visible.wokeAt - visible.axisStart) / (visible.axisEnd - visible.axisStart);
  const showRange = end > start && (!model.hasFell || !model.hasWoke || model.durationMinutes !== null);
  const ticks = sleepTimelineTicks(visible);
  return (
    <View testID="sleep-timeline">
      <View style={st.selectionLabels}>
        <Text style={st.selectionLabel}>入睡 {sleepClockLabel(model.fellAt)}{!model.hasFell ? ' · 待选' : ''}</Text>
        <Text style={st.selectionLabel}>起床 {sleepClockLabel(model.wokeAt)}{!model.hasWoke ? ' · 待选' : ''}</Text>
      </View>
      <View testID="sleep-range-track" style={st.trackArea} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <View style={st.track} pointerEvents="none" />
        {showRange && <View
          style={[st.range, { left: `${start * 100}%`, width: `${(end - start) * 100}%` }, model.durationMinutes === null && st.suggested]}
          pointerEvents="none"
        />}
        {(['fell', 'woke'] as const).map((endpoint) => <TimeHandle
          key={endpoint} endpoint={endpoint} model={visible} width={width}
          disabled={disabled || (model.hasFell && model.hasWoke && model.durationMinutes === null)}
          onChange={onChange} onDragStart={setDragAxis} onDragEnd={() => setDragAxis(null)}
        />)}
      </View>
      <View style={st.ticks}>
        {ticks.map((tick, index) => <Text key={index} style={[st.tick, { left: `${tick.ratio * 100}%` }]}>{tick.label}</Text>)}
      </View>
      <Text style={st.dateRange}>{sleepLocalTimeLabel(visible.axisStart)} → {sleepLocalTimeLabel(visible.axisEnd)}</Text>
    </View>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  selectionLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 14 },
  selectionLabel: { color: color.sleepText, fontSize: 12, fontWeight: '600', ...type.numeric },
  trackArea: { height: 44, marginHorizontal: 22, position: 'relative' },
  track: { position: 'absolute', left: 0, right: 0, top: 18, height: 8, borderRadius: 4, backgroundColor: color.paper },
  range: { position: 'absolute', top: 18, height: 8, borderRadius: 4, backgroundColor: color.sleep },
  suggested: { opacity: 0.45 },
  handle: { position: 'absolute', top: 0, width: 44, height: 44, transform: [{ translateX: -22 }], justifyContent: 'center', alignItems: 'center' },
  thumb: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.sleep, borderWidth: 2, borderColor: color.surface, alignItems: 'center', justifyContent: 'center' },
  thumbActive: { width: 32, height: 32, borderRadius: 16, borderWidth: 3 },
  disabled: { opacity: 0.45 },
  ticks: { height: 18, marginHorizontal: 22, position: 'relative' },
  tick: { position: 'absolute', width: 38, marginLeft: -19, textAlign: 'center', color: color.inkFaint, fontSize: 10, ...type.numeric },
  dateRange: { color: color.inkFaint, fontSize: 10, lineHeight: 16, marginTop: 4, textAlign: 'center', ...type.numeric },
});
