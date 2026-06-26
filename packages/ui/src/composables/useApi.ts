import axios from 'axios';

// In dev: Vite proxy forwards /api → http://localhost:3100
// In prod: nginx proxies /api → backend container
// VITE_API_URL can override for direct backend connection
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

export function useApi() {
  return api;
}

export default api;
