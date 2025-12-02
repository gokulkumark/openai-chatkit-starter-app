"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
  getThemeConfig,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = {
  type: "save";
  factId: string;
  factText: string;
};

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const processedFacts = useRef(new Set<string>());
  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const isMountedRef = useRef(true);
  const [scriptStatus, setScriptStatus] = useState<
    "pending" | "ready" | "error"
  >(() =>
    isBrowser && window.customElements?.get("openai-chatkit")
      ? "ready"
      : "pending"
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isBrowser) {
      return;
    }

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) {
        return;
      }
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js for some reason", event);
      if (!isMountedRef.current) {
        return;
      }
      setScriptStatus("error");
      const detail = (event as CustomEvent<unknown>)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener(
      "chatkit-script-error",
      handleError as EventListener
    );

    if (window.customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!window.customElements?.get("openai-chatkit")) {
          handleError(
            new CustomEvent("chatkit-script-error", {
              detail:
                "ChatKit web component is unavailable. Verify that the script URL is reachable.",
            })
          );
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener(
        "chatkit-script-error",
        handleError as EventListener
      );
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [scriptStatus, setErrorState]);

  const isWorkflowConfigured = Boolean(
    WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace")
  );

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    if (isBrowser) {
      setScriptStatus(
        window.customElements?.get("openai-chatkit") ? "ready" : "pending"
      );
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret invoked", {
          currentSecretPresent: Boolean(currentSecret),
          workflowId: WORKFLOW_ID,
          endpoint: CREATE_SESSION_ENDPOINT,
        });
      }

      if (!isWorkflowConfigured) {
        const detail =
          "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) {
          setIsInitializingSession(true);
        }
        setErrorState({ session: null, integration: null, retryable: false });
      }

      try {
        const response = await fetch(CREATE_SESSION_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflow: { id: WORKFLOW_ID },
            chatkit_configuration: {
              // enable attachments
              file_upload: {
                enabled: true,
              },
            },
          }),
        });

        const raw = await response.text();

        if (isDev) {
          console.info("[ChatKitPanel] createSession response", {
            status: response.status,
            ok: response.ok,
            bodyPreview: raw.slice(0, 1600),
          });
        }

        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch (parseError) {
            console.error(
              "Failed to parse create-session response",
              parseError
            );
          }
        }

        if (!response.ok) {
          const detail = extractErrorDetail(data, response.statusText);
          console.error("Create session request failed", {
            status: response.status,
            body: data,
          });
          throw new Error(detail);
        }

        const clientSecret = data?.client_secret as string | undefined;
        if (!clientSecret) {
          throw new Error("Missing client secret in response");
        }

        if (isMountedRef.current) {
          setErrorState({ session: null, integration: null });
        }

        return clientSecret;
      } catch (error) {
        console.error("Failed to create ChatKit session", error);
        const detail =
          error instanceof Error
            ? error.message
            : "Unable to start ChatKit session.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
        }
        throw error instanceof Error ? error : new Error(detail);
      } finally {
        if (isMountedRef.current && !currentSecret) {
          setIsInitializingSession(false);
        }
      }
    },
    [isWorkflowConfigured, setErrorState]
  );

  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: {
      colorScheme: theme,
      ...getThemeConfig(theme),
    },
    startScreen: {
      greeting: GREETING,
      prompts: STARTER_PROMPTS,
    },
    composer: {
      placeholder: PLACEHOLDER_INPUT,
      attachments: {
        // Enable attachments
        enabled: true,
      },
    },
    threadItemActions: {
      feedback: false,
    },
    onClientTool: async (invocation: {
      name: string;
      params: Record<string, unknown>;
    }) => {
      if (invocation.name === "switch_theme") {
        const requested = invocation.params.theme;
        if (requested === "light" || requested === "dark") {
          if (isDev) {
            console.debug("[ChatKitPanel] switch_theme", requested);
          }
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = String(invocation.params.fact_id ?? "");
        const text = String(invocation.params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) {
          return { success: true };
        }
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }

      return { success: false };
    },
    onResponseEnd: () => {
      onResponseEnd();
    },
    onResponseStart: () => {
      setErrorState({ integration: null, retryable: false });
    },
    onThreadChange: () => {
      processedFacts.current.clear();
    },
    onError: ({ error }: { error: unknown }) => {
      // Note that Chatkit UI handles errors for your users.
      // Thus, your app code doesn't need to display errors on UI.
      console.error("ChatKit error", error);
    },
  });

  // Listen for messages from parent window (iframe communication)
  useEffect(() => {
    if (!isBrowser) {
      console.log("[ChatKitPanel] Message listener not initialized: not in browser");
      return;
    }

    console.log("[ChatKitPanel] Message listener initialized, waiting for messages from parent window");

    const handler = (event: MessageEvent) => {
      console.log("[ChatKitPanel] Message received:", {
        origin: event.origin,
        expectedOrigin: "https://dksinsurance.com",
        data: event.data,
        dataType: event.data?.type,
      });

      if (event.origin !== "https://dksinsurance.com") {
        console.log("[ChatKitPanel] Origin mismatch, ignoring message. Expected:", "https://dksinsurance.com", "Got:", event.origin);
        return;
      }

      console.log("[ChatKitPanel] Origin check passed");

      if (event.data?.type === "INIT_PROMPT") {
        const incomingPrompt = event.data.prompt;
        console.log("[ChatKitPanel] INIT_PROMPT received:", incomingPrompt);

        // Put the text into the ChatKit input box
        // Access the web component via DOM query
        const chatKitElement = document.querySelector("openai-chatkit") as (HTMLElement & {
          focusComposer?: () => void;
          setInput?: (value: string) => void;
          sendMessage?: (message: string) => void;
        }) | null;

        console.log("[ChatKitPanel] ChatKit element found:", !!chatKitElement, {
          hasFocusComposer: typeof chatKitElement?.focusComposer === "function",
          hasSetInput: typeof chatKitElement?.setInput === "function",
          hasSendMessage: typeof chatKitElement?.sendMessage === "function",
          hasShadowRoot: !!chatKitElement?.shadowRoot,
        });

        if (chatKitElement) {
          // Try to set input value directly if method exists
          if (typeof chatKitElement.setInput === "function") {
            console.log("[ChatKitPanel] Using setInput method");
            try {
              chatKitElement.setInput(incomingPrompt);
              console.log("[ChatKitPanel] setInput called successfully");
            } catch (error) {
              console.error("[ChatKitPanel] Error calling setInput:", error);
            }
          } else {
            console.log("[ChatKitPanel] setInput not available, using DOM fallback");
            // Fallback: focus composer and set value via DOM
            try {
              chatKitElement.focusComposer?.();
              console.log("[ChatKitPanel] focusComposer called");
              
              // Helper function to search for input in shadow DOM (including nested shadow roots)
              const findInputInShadowRoot = (root: ShadowRoot | Document | Element, depth = 0): HTMLTextAreaElement | HTMLInputElement | HTMLElement | null => {
                if (depth > 3) return null; // Prevent infinite recursion
                
                // Try multiple selectors
                const selectors = [
                  "textarea",
                  "input[type='text']",
                  "input",
                  "[contenteditable='true']",
                  "[role='textbox']",
                  ".composer textarea",
                  ".composer input",
                  "[data-composer] textarea",
                  "[data-composer] input",
                  "div[contenteditable]",
                ];
                
                for (const selector of selectors) {
                  const element = root.querySelector(selector) as HTMLElement | null;
                  if (element) {
                    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
                      return element;
                    }
                    // Also check for contenteditable divs
                    if (element.isContentEditable || element.getAttribute("contenteditable") === "true") {
                      return element;
                    }
                  }
                }
                
                // Search in nested shadow roots
                const allElements = root.querySelectorAll("*");
                for (const el of allElements) {
                  if (el.shadowRoot) {
                    const found = findInputInShadowRoot(el.shadowRoot, depth + 1);
                    if (found) return found;
                  }
                }
                
                return null;
              };
              
              // Helper to set value on any element type
              const setElementValue = (element: HTMLElement, value: string) => {
                if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
                  (element as HTMLTextAreaElement | HTMLInputElement).value = value;
                  element.dispatchEvent(new Event("input", { bubbles: true }));
                  element.dispatchEvent(new Event("change", { bubbles: true }));
                } else if (element.isContentEditable || element.getAttribute("contenteditable") === "true") {
                  element.textContent = value;
                  element.dispatchEvent(new Event("input", { bubbles: true }));
                }
              };
              
              // Try to find input immediately
              let input = chatKitElement.shadowRoot 
                ? findInputInShadowRoot(chatKitElement.shadowRoot)
                : null;
              
              console.log("[ChatKitPanel] Input element found in shadow DOM (immediate):", !!input, input?.tagName);
              
              // If not found, wait a bit and try again (element might not be ready)
              if (!input) {
                console.log("[ChatKitPanel] Input not found immediately, retrying with delays...");
                
                // Try multiple times with increasing delays
                const tryFindInput = (attempt: number, maxAttempts = 5) => {
                  setTimeout(() => {
                    input = chatKitElement.shadowRoot 
                      ? findInputInShadowRoot(chatKitElement.shadowRoot)
                      : null;
                    
                    console.log(`[ChatKitPanel] Input element found in shadow DOM (attempt ${attempt}):`, !!input, input?.tagName);
                    
                    if (input) {
                      setElementValue(input, incomingPrompt);
                      console.log("[ChatKitPanel] Input value set via DOM (retry), value:", 
                        input.tagName === "TEXTAREA" || input.tagName === "INPUT" 
                          ? (input as HTMLTextAreaElement | HTMLInputElement).value 
                          : input.textContent);
                    } else if (attempt < maxAttempts) {
                      tryFindInput(attempt + 1, maxAttempts);
                    } else {
                      console.warn("[ChatKitPanel] Could not find input element in shadow DOM after all retries");
                      // Log shadow DOM structure for debugging
                      if (chatKitElement.shadowRoot) {
                        const html = chatKitElement.shadowRoot.innerHTML;
                        console.log("[ChatKitPanel] Shadow DOM structure (first 1000 chars):", html.substring(0, 1000));
                        // Also try to find any elements that might be inputs
                        const allTextareas = chatKitElement.shadowRoot.querySelectorAll("textarea, input, [contenteditable]");
                        console.log("[ChatKitPanel] Found potential input elements:", allTextareas.length, Array.from(allTextareas).map(el => ({
                          tag: el.tagName,
                          type: el.getAttribute("type"),
                          contenteditable: el.getAttribute("contenteditable"),
                          role: el.getAttribute("role"),
                        })));
                      }
                    }
                  }, attempt * 100); // 100ms, 200ms, 300ms, etc.
                };
                
                tryFindInput(1);
              } else {
                setElementValue(input, incomingPrompt);
                console.log("[ChatKitPanel] Input value set via DOM, value:", 
                  input.tagName === "TEXTAREA" || input.tagName === "INPUT" 
                    ? (input as HTMLTextAreaElement | HTMLInputElement).value 
                    : input.textContent);
              }
            } catch (error) {
              console.error("[ChatKitPanel] Error in DOM fallback:", error);
            }
          }
        } else {
          console.warn("[ChatKitPanel] ChatKit element not found in DOM");
        }

        // Optional: auto-send it
        // if (chatKitElement && typeof chatKitElement.sendMessage === "function") {
        //   chatKitElement.sendMessage(incomingPrompt);
        // }
      } else {
        console.log("[ChatKitPanel] Message type not INIT_PROMPT, ignoring. Type was:", event.data?.type);
      }
    };

    window.addEventListener("message", handler);
    console.log("[ChatKitPanel] Message event listener added");
    
    return () => {
      window.removeEventListener("message", handler);
      console.log("[ChatKitPanel] Message event listener removed");
    };
  }, []);

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render state", {
      isInitializingSession,
      hasControl: Boolean(chatkit.control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
    });
  }

  return (
    <div className="relative pb-8 flex h-[90vh] w-full rounded-2xl flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        control={chatkit.control}
        className={
          blockingError || isInitializingSession
            ? "pointer-events-none opacity-0"
            : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={
          blockingError || !isInitializingSession
            ? null
            : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}

function extractErrorDetail(
  payload: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!payload) {
    return fallback;
  }

  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  const details = payload.details;
  if (typeof details === "string") {
    return details;
  }

  if (details && typeof details === "object" && "error" in details) {
    const nestedError = (details as { error?: unknown }).error;
    if (typeof nestedError === "string") {
      return nestedError;
    }
    if (
      nestedError &&
      typeof nestedError === "object" &&
      "message" in nestedError &&
      typeof (nestedError as { message?: unknown }).message === "string"
    ) {
      return (nestedError as { message: string }).message;
    }
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  return fallback;
}
