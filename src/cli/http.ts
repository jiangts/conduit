export interface HttpClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function createHttpClient(baseUrl: string, fetchFn: typeof fetch = fetch): HttpClient {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);

  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await fetchFn(`${normalizedBaseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

      const text = await response.text();
      const payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;

      if (!response.ok) {
        if (
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof (payload as { error: unknown }).error === "string"
        ) {
          throw new Error((payload as { error: string }).error);
        }
        throw new Error(`HTTP ${response.status}`);
      }

      return payload as T;
    },
  };
}
