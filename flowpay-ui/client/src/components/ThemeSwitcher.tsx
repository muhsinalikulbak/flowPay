import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { BookOpen, Moon, Sun } from "lucide-react";

const OPTIONS = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "sepia", label: "Sepia theme", Icon: BookOpen },
  { value: "dark", label: "Dark theme", Icon: Moon },
] as const;

/** Must match the page background in each palette in index.css. */
const THEME_COLOR: Record<string, string> = {
  light: "#fbfcfe",
  sepia: "#f4ebdd",
  dark: "#0f1620",
};

export function ThemeSwitcher({ className = "" }: { className?: string }) {
  const { setTheme } = useTheme();

  // Read the attribute rather than next-themes' own state: it is the thing the
  // pre-paint script in index.html has already set, so this stays correct on
  // the very first render with no flash of the wrong selection. A MutationObserver
  // then keeps it in sync, which also covers the OS preference changing and
  // another tab changing it - neither of which go through this component.
  const [active, setActive] = useState<string>(
    () => document.documentElement.getAttribute("data-theme") ?? "light",
  );

  useEffect(() => {
    const read = () => {
      const theme = document.documentElement.getAttribute("data-theme") ?? "light";
      setActive(theme);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", THEME_COLOR[theme] ?? THEME_COLOR.light);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={`flex items-center gap-0.5 rounded-[10px] border border-line bg-sunken p-1 ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className="theme-option"
          aria-pressed={active === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
