import { AlertOctagon, RotateCcw, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FailureDescriptor } from '@/lib/api/v3';

export function FailureCard({ failure, busy, onRecover }: {
  failure: FailureDescriptor;
  busy: boolean;
  onRecover: (actionId: string) => void;
}) {
  return (
    <section className="border-b border-red-200 bg-red-50/40 px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-red-200 bg-red-100 text-red-700">
          <AlertOctagon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-red-700">{categoryLabel(failure.category)} · {failure.stage}</p>
          <h2 className="mt-0.5 text-base font-semibold text-red-950">{failure.title}</h2>
          <p className="mt-2 text-sm leading-6 text-red-900">{failure.userMessage}</p>
          <p className="mt-2 font-mono text-[10px] text-red-500">{failure.code} · {failure.failureId}</p>
        </div>
      </div>

      <div className="mt-4 border-t border-red-100 pt-4">
        <p className="text-xs font-semibold text-red-800">允许的恢复动作</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {failure.suggestedActions.map((action) => {
            const Icon = action.type === 'cancel' ? X : action.type === 'return_plan' || action.type === 'return_research' ? Undo2 : RotateCcw;
            return (
              <Button
                key={action.id}
                type="button"
                variant={action.type === 'cancel' ? 'destructive' : 'outline'}
                disabled={busy}
                title={action.description}
                onClick={() => onRecover(action.id)}
              >
                <Icon className="h-4 w-4" />{action.label}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const categoryLabel = (category: FailureDescriptor['category']): string => ({
  provider: '模型服务', tool: '工具调用', validation: '验证', runtime: '运行时', training: '训练', storage: '存储', permission: '权限',
})[category];
