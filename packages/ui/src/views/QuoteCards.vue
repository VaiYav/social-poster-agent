<script setup lang="ts">
import { ref } from 'vue';
import { ImageIcon, Sparkles, Download } from '@lucide/vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';
import { Card, Button, Input, Textarea, Select, SectionHeader } from '../components/ui';
import LoadingSpinner from '../components/LoadingSpinner.vue';

const api = useApi();
const toast = useToast();

const text = ref('');
const author = ref('Cosmic Insights');
const network = ref('X');
const generating = ref(false);
const generatedUrl = ref<string | null>(null);

async function generate() {
  if (!text.value.trim()) {
    toast.error('Please enter some text for the quote card');
    return;
  }
  generating.value = true;
  generatedUrl.value = null;
  try {
    const res = await api.post<{ path: string | null; error?: string }>('/quote-cards/generate', {
      text: text.value,
      author: author.value || undefined,
      network: network.value,
    });
    if (res.data.path) {
      generatedUrl.value = res.data.path;
      toast.success('Quote card generated!');
    } else if (res.data.error) {
      toast.error(res.data.error);
    } else {
      toast.error('Quote cards are disabled (set QUOTE_CARDS_ENABLED=true)');
    }
  } catch (err) {
    toast.error((err as Error).message ?? 'Failed to generate quote card');
  } finally {
    generating.value = false;
  }
}

const networkOptions = [
  { value: 'X', label: 'X' },
  { value: 'THREADS', label: 'Threads' },
  { value: 'FACEBOOK', label: 'Facebook' },
];

const gradients: Record<string, [string, string]> = {
  X: ['#1a1a2e', '#16213e'],
  THREADS: ['#0f0f23', '#1a1a3e'],
  FACEBOOK: ['#1e3a8a', '#1e40af'],
};
</script>

<template>
  <div>
    <SectionHeader
      title="Quote Cards"
      description="Generate image quote cards from post text (F19)."
    />

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Input form -->
      <Card>
        <template #header>
          <div class="flex items-center gap-2">
            <ImageIcon class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">Create Quote Card</h2>
          </div>
        </template>

        <div class="space-y-5">
          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Quote Text</label>
            <Textarea
              v-model="text"
              :rows="4"
              :maxlength="200"
              placeholder="Enter the quote text (max 200 chars)..."
            />
            <p class="mt-1 text-xs text-text-muted">{{ text.length }}/200</p>
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Author</label>
            <Input v-model="author" placeholder="Author name" />
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Network (affects gradient)</label>
            <Select v-model="network" :options="networkOptions" />
          </div>

          <Button
            :loading="generating"
            :disabled="!text.trim()"
            class="w-full"
            @click="generate"
          >
            <Sparkles class="h-4 w-4" />
            {{ generating ? 'Generating...' : 'Generate Quote Card' }}
          </Button>
        </div>
      </Card>

      <!-- Preview -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <ImageIcon class="h-5 w-5 text-secondary" />
              <h2 class="text-lg font-semibold text-text-primary">Preview</h2>
            </div>
            <a
              v-if="generatedUrl"
              :href="`/api/v1/quote-cards/file?path=${encodeURIComponent(generatedUrl)}`"
              download
              class="inline-flex items-center gap-1 text-xs text-primary hover:text-primary-hover"
            >
              <Download class="h-3.5 w-3.5" />
              Download
            </a>
          </div>
        </template>

        <LoadingSpinner v-if="generating" />
        <div v-else-if="generatedUrl" class="mt-2">
          <img
            :src="`/api/v1/quote-cards/file?path=${encodeURIComponent(generatedUrl)}`"
            alt="Generated quote card"
            class="rounded-lg shadow-cosmic"
          />
          <p class="mt-2 break-all text-xs text-text-muted">{{ generatedUrl }}</p>
        </div>
        <div v-else class="mt-2">
          <div
            class="flex flex-col items-center justify-center rounded-lg p-8 text-center"
            :style="{
              background: `linear-gradient(135deg, ${gradients[network]?.[0] ?? '#1a1a2e'}, ${gradients[network]?.[1] ?? '#16213e'})`,
              minHeight: '300px',
            }"
          >
            <p class="max-w-md text-xl font-semibold text-white" style="line-height: 1.4;">
              {{ text || 'Your quote will appear here...' }}
            </p>
            <p class="mt-4 text-sm italic text-white/60">— {{ author || 'Author' }}</p>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
