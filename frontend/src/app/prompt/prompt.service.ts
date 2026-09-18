import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

const API_BASE = 'https://ai-blender-video-maker.vercel.app/api/prompt';

export interface PromptResponse {
  prompt: string;
  model?: string;
}

/** What the backend sends back when a request fails. */
export interface PromptFailure {
  message: string;
  hint: string;
}

@Injectable({ providedIn: 'root' })
export class PromptService {
  constructor(private http: HttpClient) {}

  /**
   * Ask Gemini (through our own backend) for one new Blender-style
   * "oddly satisfying" video prompt idea.
   *
   * @param loop          true = the idea must be a seamless infinite loop
   * @param previousIdeas last few ideas already shown, so the model avoids repeats
   */
  generate(loop: boolean, previousIdeas: string[] = []): Observable<PromptResponse> {
    return this.http
      .post<PromptResponse>(`${API_BASE}/generate`, { loop, previousIdeas })
      .pipe(catchError((err: HttpErrorResponse) => throwError(() => this.describe(err))));
  }

  /**
   * Turn an HTTP failure into something worth reading. The point is to tell a
   * dead backend apart from a rejected key apart from a quota problem, instead
   * of showing one generic "check your API key" line for all of them.
   */
  private describe(err: HttpErrorResponse): PromptFailure {
    if (err.status === 0) {
      return {
        message: 'Cannot reach the backend (http://localhost:3000).',
        hint: 'Is the backend window still running? start.bat runs both servers together.',
      };
    }

    const body = err.error;
    if (body && typeof body === 'object') {
      return {
        message: body.error || `Request failed (HTTP ${err.status}).`,
        hint: [body.hint, body.detail ? `Detail: ${body.detail}` : ''].filter(Boolean).join(' '),
      };
    }

    return {
      message: `Request failed (HTTP ${err.status}).`,
      hint: 'The backend console has the full error.',
    };
  }
}
