import { createInterface, type Interface } from 'node:readline/promises';

export interface InteractiveTerminal {
  write(message: string): void;
  writeError(message: string): void;
  question(prompt: string): Promise<string>;
  close(): void;
}

export class ReadlineInteractiveTerminal implements InteractiveTerminal {
  private readonly terminal: Interface;

  constructor() {
    this.terminal = createInterface({ input: process.stdin, output: process.stdout });
  }

  write(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  writeError(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  question(prompt: string): Promise<string> {
    return this.terminal.question(prompt);
  }

  close(): void {
    this.terminal.close();
  }
}

export const askChoice = async (
  terminal: InteractiveTerminal,
  prompt: string,
  allowed: readonly string[],
): Promise<string> => {
  const choices = new Set(allowed);
  while (true) {
    const answer = (await terminal.question(prompt)).trim();
    if (choices.has(answer)) return answer;
    terminal.writeError(`请输入 ${allowed.join('、')} 中的一个选项。`);
  }
};

export const askNonEmpty = async (
  terminal: InteractiveTerminal,
  prompt: string,
): Promise<string> => {
  while (true) {
    const answer = (await terminal.question(prompt)).trim();
    if (answer) return answer;
    terminal.writeError('请输入内容，或输入 /cancel 返回。');
  }
};
