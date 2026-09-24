import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Config = Record<string, unknown>

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
          '仅拦截非流式、max_tokens 为 1 的辅助探测；Stage1/2 分类器透传。'
        )}
      </CardContent>
    </Card>
  )
}
