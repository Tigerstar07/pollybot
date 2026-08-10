import { mockFetch } from "./mock-router";

(globalThis as any).fetch = mockFetch;
