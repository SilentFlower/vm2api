import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Config = Record<string, unknown>
type PrimeRecord = {
  at: string
  vm_id: string
  ok: boolean
  status?: number
  skipped?: string
  error?: string
}
type PrimeStatus = {
  running: boolean
  next_run_at: string | null
  last_run: {
    at: string
    total: number
    success: number
    skipped: number
  } | null
  records: PrimeRecord[]
}

/**
 * 峰值预热时段、手动执行与最近结果。
 * @param value 当前预热配置。
 * @param onChange 配置变更回调。
 * @returns 设置卡片。
 */
export function PeakPrimePane({
  value,
  onChange,
}: {
  value: Config
  onChange: (next: Config) => void
}) {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['panel', 'peak-prime'],
    queryFn: () => api<PrimeStatus>('/api/panel/peak-prime'),
  })
  const run = useMutation({
    mutationFn: () =>
      api<PrimeStatus>('/api/panel/peak-prime', { method: 'POST' }),
    onSuccess: async () => {
      toast.success('预热已完成')
      await queryClient.invalidateQueries({ queryKey: ['panel', 'peak-prime'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const hours = Array.isArray(value.hours) ? value.hours.map(Number) : [4, 5, 6]
  const records = (status.data?.records || []).slice(-6).reverse()
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-3 pb-2'>
        <CardTitle className='text-sm'>峰值预热</CardTitle>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={run.isPending || status.data?.running}
          onClick={() => run.mutate()}
          title='用已保存的配置立即预热所有可用 Claude 槽位'
        >
          <Play className='size-4' />
          立即运行
        </Button>
      </CardHeader>
      <CardContent className='space-y-4'>
        <SettingRow
          label='按时段预热'
          desc='以服务器本地时区为准，逐个可用槽位执行真实小请求。'
        >
          <Switch
            checked={value.enabled === true}
            onCheckedChange={(enabled) => onChange({ ...value, enabled })}
            aria-label='按时段预热'
          />
        </SettingRow>
        <div className='space-y-2'>
          <div className='text-sm font-medium'>执行小时</div>
          <div className='grid grid-cols-6 gap-1 sm:grid-cols-12'>
            {Array.from({ length: 24 }, (_, hour) => (
              <label
                key={hour}
                className='flex items-center justify-center gap-1 border p-1 text-xs'
              >
                <input
                  type='checkbox'
                  checked={hours.includes(hour)}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      hours: event.target.checked
                        ? [...hours, hour].sort((a, b) => a - b)
                        : hours.filter((item) => item !== hour),
                    })
                  }
                />
                {String(hour).padStart(2, '0')}
              </label>
            ))}
          </div>
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='space-y-1.5 text-sm font-medium'>
            分钟
            <Input
              type='number'
              min={0}
              max={59}
              value={Number(value.minute ?? 10)}
              onChange={(event) =>
                onChange({ ...value, minute: Number(event.target.value) })
              }
            />
          </label>
          <label className='space-y-1.5 text-sm font-medium'>
            预热模型
            <Input
              value={String(value.model ?? 'claude-haiku-4-5')}
              onChange={(event) =>
                onChange({ ...value, model: event.target.value })
              }
            />
          </label>
        </div>
        <div className='border-t pt-3 text-xs text-muted-foreground'>
          {status.data?.last_run
            ? `上次运行 ${new Date(status.data.last_run.at).toLocaleString()} · 成功 ${status.data.last_run.success}/${status.data.last_run.total} · 跳过 ${status.data.last_run.skipped}`
            : '暂无运行记录'}
          {status.data?.next_run_at
            ? ` · 下次 ${new Date(status.data.next_run_at).toLocaleString()}`
            : ''}
        </div>
        {records.length ? (
          <div className='space-y-1 text-xs'>
            {records.map((record, index) => (
              <div
                key={`${record.at}-${record.vm_id}-${index}`}
                className='flex justify-between gap-3 border-t py-1'
              >
                <span>{record.vm_id}</span>
                <span
                  className={
                    record.ok ? 'text-emerald-600' : 'text-muted-foreground'
                  }
                >
                  {record.ok
                    ? '成功'
                    : record.skipped ||
                      record.error ||
                      `HTTP ${record.status || 0}`}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
