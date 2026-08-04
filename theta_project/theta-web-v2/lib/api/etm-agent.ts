interface LandingAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface LandingChatOptions {
  sessionId?: string;
  images?: LandingAttachment[];
  files?: LandingAttachment[];
}

interface LandingChatResponse {
  message: string;
}

interface LandingChatChunk {
  type: 'content';
  content: string;
}

const WORKBENCH_GUIDANCE =
  '已收到你的研究描述。THETA 2.0 会在工作台中通过研究访谈、列确认、计划审批和训练执行来完成任务；请点击“开始研究”进入二代工作台。';

export const ETMAgentAPI = {
  async chat(
    _message: string,
    _context?: Record<string, unknown>,
    _options?: LandingChatOptions,
  ): Promise<LandingChatResponse> {
    return { message: WORKBENCH_GUIDANCE };
  },

  async *chatStream(
    _message: string,
    _sessionId?: string,
    _context?: Record<string, unknown>,
    _images?: LandingAttachment[],
    _files?: LandingAttachment[],
  ): AsyncGenerator<LandingChatChunk> {
    yield { type: 'content', content: WORKBENCH_GUIDANCE };
  },
};
