import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { PromptService, PromptFailure } from './prompt.service';
import { PromptBridgeService } from '../shared/prompt-bridge.service';

@Component({
  selector: 'app-prompt',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './prompt.component.html',
  styleUrl: './prompt.component.scss',
})
export class PromptComponent {
  loopEnabled = true;
  prompt = '';
  isLoading = false;
  errorMessage: string | null = null;
  errorHint: string | null = null;
  copied = false;

  /** Last few ideas, sent back to the model so it stops repeating itself. */
  history: string[] = [];

  constructor(
    private promptService: PromptService,
    private bridge: PromptBridgeService,
    private router: Router
  ) {}

  toggleLoop(): void {
    this.loopEnabled = !this.loopEnabled;
  }

  onGenerate(): void {
    this.isLoading = true;
    this.errorMessage = null;
    this.errorHint = null;
    this.copied = false;

    this.promptService.generate(this.loopEnabled, this.history).subscribe({
      next: (res) => {
        this.prompt = res.prompt;
        this.history = [res.prompt, ...this.history].slice(0, 6);
        this.isLoading = false;
      },
      error: (err: PromptFailure) => {
        this.errorMessage = err?.message ?? 'Something went wrong.';
        this.errorHint = err?.hint || null;
        this.isLoading = false;
      },
    });
  }

  onCopy(): void {
    if (!this.prompt) return;
    navigator.clipboard.writeText(this.prompt).then(() => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1800);
    });
  }

  /** Send this prompt over to the Text → Video page, ready to generate. */
  onUseForVideo(): void {
    if (!this.prompt) return;
    this.bridge.set(this.prompt);
    this.router.navigate(['/video']);
  }
}
