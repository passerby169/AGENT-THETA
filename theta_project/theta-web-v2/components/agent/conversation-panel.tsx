'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Check, MessageCircleQuestion, RefreshCw, Send, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ConversationMessage } from '@/lib/api/v3';

interface PendingMessage {
  clientMessageId: string;
  content: string;
  createdAt: string;
}

export function ConversationPanel({
  messages,
  pendingMessages,
  canSend,
  busy,
  prompt,
  onSend,
}: {
  messages: ConversationMessage[];
  pendingMessages: PendingMessage[];
  canSend: boolean;
  busy: boolean;
  prompt?: string;
  onSend: (content: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, pendingMessages.length]);

  const submit = async () => {
    const value = draft.trim();
    if (!value || busy || !canSend) return;
    setDraft('');
    await onSend(value);
  };

  return (
    <section className="flex min-h-[420px] flex-col bg-white lg:h-[calc(100dvh-112px)]">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">研究对话</p>
        <p className="mt-0.5 text-xs text-slate-500">询问、解释和修改统一在这里进行</p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((message) => <MessageBubble key={message.messageId} message={message} />)}
        {pendingMessages.map((message) => (
          <div key={message.clientMessageId} className="flex justify-end">
            <div className="max-w-[88%] rounded-md bg-blue-600 px-3 py-2 text-sm leading-6 text-white opacity-70">
              {message.content}
              <p className="mt-1 text-[10px] text-blue-100">正在发送</p>
            </div>
          </div>
        ))}
        {!messages.length && !pendingMessages.length ? (
          <div className="grid min-h-52 place-items-center text-center">
            <div>
              <Bot className="mx-auto h-7 w-7 text-slate-300" />
              <p className="mt-2 text-sm text-slate-500">Agent 的问题和结论将在这里出现。</p>
            </div>
          </div>
        ) : null}
        <div ref={messageEndRef} />
      </div>
      <div className="border-t border-slate-200 p-3">
        {prompt ? <p className="mb-2 text-xs leading-5 text-slate-500">{prompt}</p> : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={canSend ? '直接说明你的问题或修改要求…' : '当前阶段暂不接受消息'}
            disabled={!canSend || busy}
            className="max-h-36 min-h-20 resize-none"
          />
          <Button type="button" size="icon" title="发送消息" disabled={!canSend || busy || !draft.trim()} onClick={() => void submit()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const user = message.role === 'user';
  const presentation = messagePresentation[message.kind];
  return (
    <div className={`flex gap-2.5 ${user ? 'justify-end' : 'justify-start'}`}>
      {!user ? (
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600"><Bot className="h-3.5 w-3.5" /></div>
      ) : null}
      <div className={`max-w-[88%] rounded-md px-3 py-2 text-sm leading-6 ${user ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-slate-50 text-slate-800'}`}>
        {!user && presentation ? (
          <Badge variant="outline" className={`mb-1.5 ${presentation.className}`}>
            <presentation.icon className="h-3 w-3" />{presentation.label}
          </Badge>
        ) : null}
        <p className="whitespace-pre-wrap">{message.content}</p>
        {message.citations?.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.citations.map((citation) => (
              <span key={citation.refId} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500">
                {citation.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${user ? 'text-blue-100' : 'text-slate-400'}`}>
          <span>{formatTime(message.createdAt)}</span>
          {message.status === 'processing' ? <span>处理中</span> : null}
          {message.status === 'failed' ? <span className="text-red-600">失败</span> : null}
        </div>
      </div>
      {user ? (
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-700"><UserRound className="h-3.5 w-3.5" /></div>
      ) : null}
    </div>
  );
}

const formatTime = (value: string): string => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(value));

const messagePresentation: Partial<Record<
  ConversationMessage['kind'],
  { label: string; icon: typeof Bot; className: string }
>> = {
  agent_question: {
    label: 'Agent 提问',
    icon: MessageCircleQuestion,
    className: 'border-sky-200 bg-sky-50 text-sky-700',
  },
  agent_summary: {
    label: '研究总结',
    icon: Bot,
    className: 'border-slate-200 bg-white text-slate-600',
  },
  checkpoint_proposed: {
    label: '等待确认',
    icon: MessageCircleQuestion,
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  checkpoint_revised: {
    label: '已修订',
    icon: RefreshCw,
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  checkpoint_confirmed: {
    label: '已确认',
    icon: Check,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
};
