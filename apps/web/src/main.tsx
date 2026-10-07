import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { FeedbackProvider } from "./components/feedback";
import "./i18n";
import { SessionProvider } from "./session";
import "./styles.css";
import { applyTheme, readTheme } from "./theme";

applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
