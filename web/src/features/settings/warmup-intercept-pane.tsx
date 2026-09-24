import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Config = Record<string, unknown>
const CLASSIFIER_MODES = [
  ['passthrough', '转发上游'],
  ['mock_allow', '本地允许'],
  ['mock_block', '本地阻止'],
  ['error', '返回错误'],
] as const

/**
 * Claude Code 辅助请求的本地响应开关。
 * @param value 当前拦截配置。
 * @param onChange 配置变更回调。
 * @returns 设置卡片。
 */
export function WarmupInterceptPane({
  value,
  onChange,
}: {
  value: Config
  onChange: (next: Config) => void
}) {
  const toggle = (key: string, label: string, desc: string) => (
    <SettingRow label={label} desc={desc}>
      <Switch
        checked={value[key] === true}
        onCheckedChange={(checked) => onChange({ ...value, [key]: checked })}
        aria-label={label}
      />
    </SettingRow>
  )
  const classifierMode = (key: string, label: string, desc: string) => (
    <SettingRow label={label} desc={desc}>
      <Select
        value={
          CLASSIFIER_MODES.some(([mode]) => mode === value[key])
            ? String(value[key])
            : 'passthrough'
        }
        onValueChange={(mode) => onChange({ ...value, [key]: mode })}
      >
        <SelectTrigger className='w-36' aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLASSIFIER_MODES.map(([mode, text]) => (
            <SelectItem key={mode} value={mode}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>辅助请求拦截</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        {toggle('title_enabled', '对话标题', '本地返回标题，不消耗上游额度。')}
        {toggle('suggestion_enabled', '建议模式', '本地返回空建议。')}
        {toggle(
          'haiku_probe_enabled',
          'Haiku 短探测',
          '仅拦截非流式、max_tokens 为 1 的辅助探测。'
        )}
        {classifierMode(
          'auto_mode_classifier_stage1_mode',
          'Auto Mode · Stage 1',
          '64–2304 tokens；本地允许会跳过上游判定。'
        )}
        {classifierMode(
          'auto_mode_classifier_stage2_mode',
          'Auto Mode · Stage 2',
          '4096–8192 tokens；本地允许会跳过上游判定。'
        )}
      </CardContent>
    </Card>
  )
}
