import { Injectable } from '@angular/core';

/**
 * Tiny hand-off between the two pages. The Prompt Ideas page drops a prompt
 * in here and navigates to the video page, which picks it up once and clears
 * it — so hitting refresh doesn't silently re-fill the textarea.
 */
@Injectable({ providedIn: 'root' })
export class PromptBridgeService {
  private pending: string | null = null;

  set(prompt: string): void {
    this.pending = prompt;
  }

  /** Returns the pending prompt (if any) and clears it. */
  take(): string | null {
    const value = this.pending;
    this.pending = null;
    return value;
  }
}
