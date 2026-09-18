import { Routes } from '@angular/router';
import { GeneratorComponent } from './generator/generator.component';
import { PromptComponent } from './prompt/prompt.component';

export const routes: Routes = [
  { path: 'video', component: GeneratorComponent, title: 'Text to Video' },
  { path: 'prompt', component: PromptComponent, title: 'Prompt Ideas' },
  { path: '', pathMatch: 'full', redirectTo: 'video' },
  { path: '**', redirectTo: 'video' },
];
