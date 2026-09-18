import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { GenerationService, JobStatus } from './generation.service';
import { PromptBridgeService } from '../shared/prompt-bridge.service';

@Component({
  selector: 'app-generator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './generator.component.html',
  styleUrl: './generator.component.scss',
})
export class GeneratorComponent implements OnInit, OnDestroy {
  prompt = '';
  isGenerating = false;
  status: JobStatus | 'idle' = 'idle';
  progress = 0;
  videoUrl: string | null = null;
  errorMessage: string | null = null;
  warningMessage: string | null = null;
  /** Set when the prompt arrived from the Prompt Ideas page. */
  fromPromptPage = false;

  private pollSub?: Subscription;

  constructor(
    private generationService: GenerationService,
    private promptBridge: PromptBridgeService
  ) {}

  ngOnInit(): void {
    // If the user clicked "Use for video" on the Prompt Ideas page, that
    // prompt is waiting for us here.
    const handedOver = this.promptBridge.take();
    if (handedOver) {
      this.prompt = handedOver;
      this.fromPromptPage = true;
    }
  }

  get statusLabel(): string {
    switch (this.status) {
      case 'pending':
        return 'Queued';
      case 'processing':
        return 'Processing';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return '';
    }
  }

  onGenerate(): void {
    const trimmed = this.prompt.trim();
    this.warningMessage = null;
    this.errorMessage = null;
    this.fromPromptPage = false;

    if (!trimmed) {
      this.warningMessage = 'Please enter a prompt before generating a video.';
      return;
    }

    this.pollSub?.unsubscribe();
    this.videoUrl = null;
    this.progress = 0;
    this.isGenerating = true;
    this.status = 'pending';

    this.generationService.submitGeneration(trimmed).subscribe({
      next: (res) => {
        this.status = res.status;
        this.startPolling(res.jobId);
      },
      error: (err) => {
        this.errorMessage = typeof err === 'string' ? err : 'Failed to start video generation.';
        this.isGenerating = false;
        this.status = 'idle';
      },
    });
  }

  onDownload(): void {
    if (!this.videoUrl) {
      return;
    }
    const link = document.createElement('a');
    link.href = this.videoUrl;
    link.download = 'generated-video.mp4';
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private startPolling(jobId: string): void {
    this.pollSub = this.generationService.pollStatus(jobId).subscribe({
      next: (job) => {
        this.status = job.status;
        this.progress = job.progress ?? 0;

        if (job.status === 'completed') {
          this.videoUrl = job.videoUrl ?? null;
          this.isGenerating = false;
        } else if (job.status === 'failed') {
          this.errorMessage = job.error || 'Video generation failed.';
          this.isGenerating = false;
        }
      },
      error: (err) => {
        this.errorMessage =
          typeof err === 'string' ? err : 'Something went wrong while checking the video status.';
        this.isGenerating = false;
      },
    });
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }
}
