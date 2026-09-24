import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow } from '@/components/setting-row'

type Config = Record<string, unknown>

/**
 * 客户端版本和 User-Agent 准入设置。
 * @param value 当前准入配置。
 * @param onChange 配置变更回调。
 * @returns 设置卡片。
 */
export function ClientAccessPane({
  value,
  onChange,
}: {
  value: Config
  onChange: (next: Config) => void
}) {
  const field = (key: string, label: string, placeholder: string) => (
    <div className='space-y-1.5'>
      <label className='text-sm font-medium' htmlFor={`client-access-${key}`}>
        {label}
      </label>
      <Textarea
        id={`client-access-${key}`}
        value={String(value[key] || '')}
        placeholder={placeholder}
        className='min-h-16 font-mono text-xs'
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
      />
    </div>
  )
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>客户端准入</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <SettingRow label='启用准入' desc='未填写允许列表时不限制该类客户端。'>
          <Switch
            checked={value.enabled === true}
            onCheckedChange={(enabled) => onChange({ ...value, enabled })}
            aria-label='启用客户端准入'
          />
        </SettingRow>
        {field(
          'allowed_claude_code_versions',
          '允许的 Claude Code 版本',
          '2.1.89-2.1.280, 2.2.*'
        )}
        {field(
          'blocked_claude_code_versions',
          '禁止的 Claude Code 版本',
          '2.1.100'
        )}
        {field(
          'allowed_user_agents',
          '其它客户端允许的 User-Agent',
          'my-client/*, curl/*'
        )}
      </CardContent>
    </Card>
  )
}
