import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Frame, Toast } from "@shopify/polaris";

interface ToastOptions {
  isError?: boolean;
  duration?: number;
}

interface ToastApi {
  show: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// Non-embedded pages have no App Bridge host, so `shopify.toast.show(...)`
// (from useAppBridge) isn't available - this reproduces the same API on top
// of Polaris's own Frame/Toast so call sites only need a different import.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; isError: boolean; duration?: number } | null>(
    null,
  );

  const show = useCallback((message: string, options?: ToastOptions) => {
    setToast({ message, isError: options?.isError ?? false, duration: options?.duration });
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      <Frame>
        {children}
        {toast && (
          <Toast
            content={toast.message}
            error={toast.isError}
            duration={toast.duration ?? 5000}
            onDismiss={() => setToast(null)}
          />
        )}
      </Frame>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
