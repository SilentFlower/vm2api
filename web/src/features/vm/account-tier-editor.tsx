import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

type AccountTierChoice = 'auto' | 'pro' | 'max'

function selectedTier(vm: Vm): AccountTierChoice {
  if (vm.account_tier_mode !== 'manual') return 'auto'
  return vm.account_tier === 'max' ? 'max' : 'pro'
}

/**
 * 热更新 Claude 槽的套餐识别方式。
 * @param props 组件参数。
 * @param props.vm 当前槽位。
 * @return 套餐选择器。
 */
export function AccountTierEditor({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const current = selectedTier(vm)
  const save = useMutation({
    mutationFn: (choice: AccountTierChoice) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/account-tier`, {
        method: 'POST',
        body: JSON.stringify({
          account_tier_mode: choice === 'auto' ? 'auto' : 'manual',
          account_tier: choice === 'auto' ? undefined : choice,
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      toast.success('账号类型已更新')
    },
    onError: (error: Error) => toast.error(error.message || '账号类型更新失败'),
  })

  return (
    <Select
      value={current}
      onValueChange={(value) => save.mutate(value as AccountTierChoice)}
      disabled={save.isPending}
    >
      <SelectTrigger className='h-7 w-28 text-xs'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value='auto'>自动识别</SelectItem>
        <SelectItem value='pro'>手动 Pro</SelectItem>
        <SelectItem value='max'>手动 Max</SelectItem>
      </SelectContent>
    </Select>
  )
}
