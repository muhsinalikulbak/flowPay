import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  // Sonner only understands light/dark/system, so the sepia palette is rendered
  // with its light chrome. The colours themselves still come from the tokens
  // below, so a sepia toast matches the page rather than the light page.
  const scheme = theme === "sepia" ? "light" : theme;

  return (
    <Sonner
      theme={scheme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--surface-raised)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--line)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
