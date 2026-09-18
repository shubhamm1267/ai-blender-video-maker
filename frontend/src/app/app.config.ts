import { ApplicationConfig } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    // Hash URLs (#/video, #/prompt) so a browser refresh works without any
    // extra dev-server or static-host rewrite configuration.
    provideRouter(routes, withHashLocation()),
  ],
};
