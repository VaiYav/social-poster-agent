import { createApp } from "vue";
import { createPinia } from "pinia";
import * as Sentry from "@sentry/vue";
import App from "./App.vue";
import router from "./router";
import "./assets/css/main.css";

const app = createApp(App);

// Initialize Sentry for UI error tracking (no-op if VITE_SENTRY_DSN not set)
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    app,
    dsn: sentryDsn,
    environment: import.meta.env.MODE ?? "development",
    release: import.meta.env.VITE_SPA_RELEASE ?? "spa-ui@0.4.2",
    integrations: [Sentry.browserTracingIntegration({ router })],
    tracesSampleRate: parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // Filter out health check and docs routes
    ignoreErrors: ["Non-Error promise rejection captured"],
  });
}

app.use(createPinia());
app.use(router);
app.mount("#app");
