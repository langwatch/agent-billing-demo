import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import "./index.css";
import { LiveFeedProvider } from "./liveFeed";
import { Admin } from "./pages/Admin";
import { Dashboard } from "./pages/Dashboard";
import { Developer } from "./pages/Developer";
import { Landing } from "./pages/Landing";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { SessionProvider } from "./session";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <LiveFeedProvider>
          <ToastProvider>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/signup" element={<SignUp />} />
              <Route path="/signin" element={<SignIn />} />
              <Route path="/app" element={<Dashboard />} />
              <Route path="/developer" element={<Developer />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ToastProvider>
        </LiveFeedProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
