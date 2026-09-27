import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import Home from "./pages/Home";

export default function App() {
  return (
    <ErrorBoundary>
      {/* Drives the data-theme attribute the palettes in index.css key off.
          enableSystem honours prefers-color-scheme for the first visit; sepia
          is opt-in and sticks once chosen. */}
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        themes={["light", "sepia", "dark"]}
      >
        <TooltipProvider>
          <Toaster />
          <Home />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
