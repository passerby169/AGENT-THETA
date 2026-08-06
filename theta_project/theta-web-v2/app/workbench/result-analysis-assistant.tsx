'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageIcon, ListPlus, Loader2, Paperclip, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  ThetaAgentV2API,
  type ThetaResultAnalysisSelection,
} from '@/lib/api/theta-agent-v2';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

interface SelectionAttachment {
  selection: ThetaResultAnalysisSelection;
  items: string[];
  visualizations: SelectedVisualization[];
}

interface SelectedVisualization {
  id: string;
  label: string;
  format: 'image' | 'interactive';
  src: string;
}

export function ResultAnalysisAssistant({
  runId,
  selection,
  selectionCount,
  selectedItems,
  selectedVisualizations,
  allSelection,
  allSelectionCount,
  allSelectedItems,
  allSelectedVisualizations,
  onSelectAll,
}: {
  runId: string;
  selection: ThetaResultAnalysisSelection;
  selectionCount: number;
  selectedItems: string[];
  selectedVisualizations: SelectedVisualization[];
  allSelection: ThetaResultAnalysisSelection;
  allSelectionCount: number;
  allSelectedItems: string[];
  allSelectedVisualizations: SelectedVisualization[];
  onSelectAll: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [attachment, setAttachment] = useState<SelectionAttachment>();
  const endRef = useRef<HTMLDivElement>(null);
  const selectionSignature = JSON.stringify(selection);

  useEffect(() => {
    setMessages([]);
    setQuestion('');
    setError(undefined);
    setAttachment(undefined);
  }, [runId]);

  useEffect(() => {
    setAttachment(undefined);
  }, [selectionSignature]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [busy, messages]);

  const send = async () => {
    const content = question.trim();
    if (busy) return;
    if (!attachment) {
      setError(selectionCount ? '请先点击“获取所勾选内容”，确认本次要交给猫咪科学家的结果。' : '请先在左侧勾选指标、图表或研究核对内容。');
      return;
    }
    if (!content) {
      setError('请先填写希望猫咪科学家分析的问题。');
      return;
    }
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
    };
    const lastMessage = messages.at(-1);
    const retrying = Boolean(
      error && lastMessage?.role === 'user' && lastMessage.content === content,
    );
    const historyMessages = retrying ? messages.slice(0, -1) : messages;
    const priorHistory = historyMessages
      .slice(-8)
      .map(({ role, content: historyContent }) => ({ role, content: historyContent }));
    if (!retrying) setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setBusy(true);
    setError(undefined);
    try {
      const response = await ThetaAgentV2API.analyzeResults(runId, {
        question: content,
        selection: attachment.selection,
        history: priorHistory,
      });
      setMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.answer,
        model: response.model,
      }]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setQuestion(content);
      setError(
        message.includes('exceeded') || message.toLowerCase().includes('timeout')
          ? 'MiniMax 响应超时，问题和分析附件均已保留。请稍后直接点击“重新发送”。'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const capture = (
    nextSelection: ThetaResultAnalysisSelection,
    nextItems: string[],
    nextVisualizations: SelectedVisualization[],
  ) => {
    setAttachment({
      selection: {
        topicIds: [...nextSelection.topicIds],
        metricKeys: [...nextSelection.metricKeys],
        visualizationIds: [...nextSelection.visualizationIds],
        includeGoalAssessment: nextSelection.includeGoalAssessment,
        includeWarnings: nextSelection.includeWarnings,
      },
      items: [...nextItems],
      visualizations: [...nextVisualizations],
    });
    setError(undefined);
  };

  const captureSelection = () => {
    if (!selectionCount) return;
    capture(selection, selectedItems, selectedVisualizations);
  };

  const captureAll = () => {
    if (!allSelectionCount) return;
    onSelectAll();
    capture(allSelection, allSelectedItems, allSelectedVisualizations);
  };

  const choosePrompt = (prompt: string) => {
    if (!attachment) {
      if (selectionCount) captureSelection();
      else captureAll();
    }
    setQuestion(prompt);
    setError(undefined);
  };

  return (
    <aside className="flex self-start flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg shadow-slate-200/70 xl:sticky xl:top-20 xl:h-[calc(100vh-6rem)]">
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-blue-50">
          <img src="/ai-avatar.png" alt="猫咪科学家" className="h-16 w-16 object-contain" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">猫咪科学家</h2>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
            <ShieldCheck className="h-3 w-3 text-emerald-600" />仅包含已勾选结果
          </p>
        </div>
        <span className={`ml-auto rounded-sm px-2 py-1 text-[11px] font-semibold ${attachment ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{attachment ? `已载入 ${attachment.items.length}` : selectionCount ? `已勾选 ${selectionCount}` : '未选择范围'}</span>
      </div>

      <div className="max-h-[52vh] min-h-80 space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4 xl:min-h-0 xl:max-h-none xl:flex-1">
        {messages.length ? messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] rounded-md px-3 py-2.5 text-sm leading-6 ${message.role === 'user' ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}>
              <p className="whitespace-pre-wrap">{message.content}</p>
              {message.model ? <p className="mt-2 text-[10px] text-slate-400">{message.model}</p> : null}
            </div>
          </div>
        )) : (
          <div className="space-y-3">
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-3 text-xs leading-5 text-blue-900">
              <Sparkles className="mb-2 h-4 w-4 text-blue-600" />
              可以直接载入全部结果进行审核，也可以先在左侧勾选指标或图表，只分析关注内容。载入不会调用 AI，点击“发送分析”后才会产生请求。
            </div>
            {['总结所选结果的主要发现', '指出这些结果的研究限制', '给出下一步验证建议'].map((prompt) => (
              <button key={prompt} type="button" disabled={busy || allSelectionCount === 0} onClick={() => choosePrompt(prompt)} className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-600 hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {prompt}
              </button>
            ))}
          </div>
        )}
        {busy ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-blue-600" />正在分析已选结果，复杂问题可能需要 1–2 分钟...</div> : null}
        {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error}</div> : null}
        <div ref={endRef} />
      </div>

      <div className="border-t border-slate-100 p-3">
        {messages.length === 0 ? (
          <>
            <div className="mb-2 grid gap-2">
              <Button type="button" variant={selectionCount ? 'default' : 'outline'} size="sm" onClick={captureSelection} disabled={busy || selectionCount === 0} className="w-full gap-2">
                <ListPlus className="h-3.5 w-3.5" />{selectionCount ? `载入已勾选结果（${selectionCount} 项）` : '尚未勾选结果'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={captureAll} disabled={busy || allSelectionCount === 0} className="w-full gap-2">
                <Sparkles className="h-3.5 w-3.5" />载入全部可分析结果（{allSelectionCount} 项）
              </Button>
            </div>
            {attachment ? (
              <div className="mb-2 rounded-md border border-blue-100 bg-blue-50/70 p-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-800"><Paperclip className="h-3 w-3" />分析附件 · {attachment.items.length} 项</p>
                {attachment.visualizations.length ? <div className="mt-2 grid grid-cols-3 gap-1.5">{attachment.visualizations.slice(0, 3).map((item) => item.format === 'image' ? <div key={item.id} className="aspect-[4/3] overflow-hidden rounded-sm border border-blue-100 bg-white"><img src={item.src} alt={item.label} className="h-full w-full object-contain" /></div> : <div key={item.id} className="grid aspect-[4/3] place-items-center rounded-sm border border-blue-100 bg-white text-blue-600" title={item.label}><ImageIcon className="h-4 w-4" /></div>)}</div> : null}
                <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                  {attachment.items.slice(0, 8).map((item, index) => <span key={`${index}-${item}`} className="max-w-full truncate rounded-sm bg-white px-2 py-1 text-[10px] text-slate-600">{item}</span>)}
                  {attachment.items.length > 8 ? <span className="rounded-sm bg-white px-2 py-1 text-[10px] text-slate-500">另有 {attachment.items.length - 8} 项</span> : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        <Textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={attachment ? '补充你的分析需求和思路...' : '可以先填写分析需求，再获取所勾选内容'}
          disabled={busy}
          className="min-h-20 resize-none text-sm"
        />
        <Button type="button" size="sm" onClick={() => void send()} disabled={busy} className="mt-2 w-full gap-2 bg-blue-600 hover:bg-blue-700">
          <Send className="h-3.5 w-3.5" />{error && messages.length ? '重新发送' : '发送分析'}
        </Button>
      </div>
    </aside>
  );
}
