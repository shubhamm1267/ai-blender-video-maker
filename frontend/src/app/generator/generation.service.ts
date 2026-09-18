import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, interval, throwError } from 'rxjs';
import { switchMap, takeWhile, catchError } from 'rxjs/operators';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationJob {
  jobId: string;
  status: JobStatus;
  progress?: number;
  videoUrl?: string | null;
  error?: string | null;
}

const API_BASE = 'http://localhost:3000/api';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // 100 * 3s = 5 minutes, matches the backend timeout

@Injectable({ providedIn: 'root' })
export class GenerationService {
  constructor(private http: HttpClient) {}

  /** Kicks off video generation for a prompt. Returns the new job's id and initial status. */
  submitGeneration(prompt: string): Observable<{ jobId: string; status: JobStatus }> {
    return this.http
      .post<{ jobId: string; status: JobStatus }>(`${API_BASE}/generate`, { prompt })
      .pipe(catchError((err: HttpErrorResponse) => throwError(() => this.toMessage(err))));
  }

  /**
   * Polls GET /api/status/:jobId every 3 seconds until the job reaches a
   * terminal state (completed/failed), or 5 minutes pass without one.
   */
  pollStatus(jobId: string): Observable<GenerationJob> {
    let attempts = 0;

    return interval(POLL_INTERVAL_MS).pipe(
      switchMap(() => {
        attempts++;
        if (attempts > MAX_POLL_ATTEMPTS) {
          return throwError(() => new Error('Video generation timed out after 5 minutes.'));
        }
        return this.http.get<GenerationJob>(`${API_BASE}/status/${jobId}`).pipe(
          switchMap((job) => {
            if (job.videoUrl && job.videoUrl.startsWith('/')) {
              job.videoUrl = `http://localhost:3000${job.videoUrl}`;
            }
            return new Observable<GenerationJob>((subscriber) => {
              subscriber.next(job);
              subscriber.complete();
            });
          })
        );
      }),
      takeWhile((job) => job.status !== 'completed' && job.status !== 'failed', true),
      catchError((err: HttpErrorResponse | Error) =>
        throwError(() => (err instanceof HttpErrorResponse ? this.toMessage(err) : err.message))
      )
    );
  }

  private toMessage(err: HttpErrorResponse): string {
    if (err.error?.error) {
      return err.error.error;
    }
    if (err.status === 0) {
      return 'Cannot reach the backend. Is it running on http://localhost:3000?';
    }
    return `Request failed (HTTP ${err.status}).`;
  }
}
