'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, ShieldCheck, Sparkles } from 'lucide-react';
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

export function ResultAnalysisAssistant({
  runId,
  selection,
  selectionCount,
}: {
  runId: string;
  selection: ThetaResultAnalysisSelection;
  selectionCount: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setQuestion('');
    setError(undefined);
  }, [runId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [busy, messages]);

  const send = async (suggestedQuestion?: string) => {
    const content = (suggestedQuestion ?? question).trim();
    if (busy || !content || selectionCount === 0) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
    };
    const priorHistory = messages
      .slice(-8)
      .map(({ role, content: historyContent }) => ({ role, content: historyContent }));
    setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setBusy(true);
    setError(undefined);
    try {
      const response = await ThetaAgentV2API.analyzeResults(runId, {
        question: content,
        selection,
        history: priorHistory,
      });
      setMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.answer,
        model: response.model,
      }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="self-start overflow-hidden rounded-md border border-slate-200 bg-white xl:sticky xl:top-20">
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
        <span className="ml-auto rounded-sm bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700">已选 {selectionCount}</span>
      </div>

      <div className="max-h-[52vh] min-h-80 space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4">
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
              先在左侧勾选结果，再选择问题或直接提问。
            </div>
            {['总结所选结果的主要发现', '指出这些结果的研究限制', '给出下一步验证建议'].map((prompt) => (
              <button key={prompt} type="button" disabled={selectionCount === 0} onClick={() => void send(prompt)} className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-600 hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {prompt}
              </button>
            ))}
          </div>
        )}
        {busy ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-blue-600" />正在分析已选结果...</div> : null}
        {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error}</div> : null}
        <div ref={endRef} />
      </div>

      <div className="border-t border-slate-100 p-3">
        <Textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={selectionCount ? '询问所选结果...' : '请先勾选左侧结果'}
          disabled={busy || selectionCount === 0}
          className="min-h-20 resize-none text-sm"
        />
        <Button type="button" size="sm" onClick={() => void send()} disabled={busy || selectionCount === 0 || !question.trim()} className="mt-2 w-full gap-2 bg-blue-600 hover:bg-blue-700">
          <Send className="h-3.5 w-3.5" />发送分析
        </Button>
      </div>
    </aside>
  );
}
