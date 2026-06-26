import { ref, onUnmounted } from 'vue';

export function useSSE(url: string) {
  const data = ref<unknown>(null);
  const error = ref<string | null>(null);
  const isConnected = ref(false);

  let eventSource: EventSource | null = null;

  function connect(): void {
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      isConnected.value = true;
      error.value = null;
    };

    eventSource.onerror = () => {
      isConnected.value = false;
      error.value = 'SSE connection lost';
    };

    eventSource.onmessage = (event) => {
      try {
        data.value = JSON.parse(event.data);
      } catch {
        data.value = event.data;
      }
    };
  }

  function disconnect(): void {
    eventSource?.close();
    eventSource = null;
    isConnected.value = false;
  }

  connect();

  onUnmounted(() => {
    disconnect();
  });

  return { data, error, isConnected, disconnect, reconnect: connect };
}
