/**
 * Reusable chart components built on chart.js + vue-chartjs.
 *
 * Usage:
 *   <BarChart :data="data" :options="options" />
 *   <LineChart :data="data" :options="options" />
 *   <DoughnutChart :data="data" :options="options" />
 */
import { defineComponent, h } from "vue";
import { Bar, Line, Doughnut } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartData,
  type ChartOptions,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

// Common chart options with dark theme
const commonOptions: ChartOptions<"bar" | "line"> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: { color: "#94a3b8", font: { size: 12 } },
    },
    tooltip: {
      backgroundColor: "rgba(15, 23, 42, 0.95)",
      titleColor: "#e2e8f0",
      bodyColor: "#94a3b8",
      borderColor: "rgba(99, 102, 241, 0.3)",
      borderWidth: 1,
    },
  },
  scales: {
    x: {
      ticks: { color: "#64748b", font: { size: 11 } },
      grid: { color: "rgba(148, 163, 184, 0.1)" },
    },
    y: {
      ticks: { color: "#64748b", font: { size: 11 } },
      grid: { color: "rgba(148, 163, 184, 0.1)" },
    },
  },
};

export const BarChart = defineComponent({
  name: "BarChart",
  props: {
    data: { type: Object as () => ChartData<"bar">, required: true },
    options: { type: Object as () => ChartOptions<"bar">, default: () => ({}) },
  },
  setup(props) {
    return () =>
      h(Bar, {
        data: props.data,
        options: { ...commonOptions, ...props.options } as ChartOptions<"bar">,
      });
  },
});

export const LineChart = defineComponent({
  name: "LineChart",
  props: {
    data: { type: Object as () => ChartData<"line">, required: true },
    options: { type: Object as () => ChartOptions<"line">, default: () => ({}) },
  },
  setup(props) {
    return () =>
      h(Line, {
        data: props.data,
        options: { ...commonOptions, ...props.options } as ChartOptions<"line">,
      });
  },
});

export const DoughnutChart = defineComponent({
  name: "DoughnutChart",
  props: {
    data: { type: Object as () => ChartData<"doughnut">, required: true },
    options: { type: Object as () => ChartOptions<"doughnut">, default: () => ({}) },
  },
  setup(props) {
    return () =>
      h(Doughnut, {
        data: props.data,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "bottom",
              labels: { color: "#94a3b8", font: { size: 12 } },
            },
            tooltip: {
              backgroundColor: "rgba(15, 23, 42, 0.95)",
              titleColor: "#e2e8f0",
              bodyColor: "#94a3b8",
            },
          },
          ...props.options,
        } as ChartOptions<"doughnut">,
      });
  },
});
