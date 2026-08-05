"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "next-themes";

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const findPortalRoot = () => {
      const githubLink = document.querySelector('.nextra-navbar a[href*="github.com"]');
      if (!githubLink?.parentElement) return null;

      const anchor = githubLink.parentElement;
      let root = anchor.querySelector<HTMLElement>(".kh-theme-toggle");
      if (!root) {
        root = document.createElement("div");
        root.className = "kh-theme-toggle";
        githubLink.parentElement.insertBefore(root, githubLink.nextSibling);
      }

      return root;
    };

    const root = findPortalRoot();
    if (root) {
      setPortalRoot(root);
      return;
    }

    const observer = new MutationObserver(() => {
      const nextRoot = findPortalRoot();
      if (nextRoot) {
        setPortalRoot(nextRoot);
        observer.disconnect();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);

    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      const existing = document.querySelector(".kh-theme-toggle");
      existing?.remove();
    };
  }, [mounted]);

  function toggle() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }

  if (!mounted || !portalRoot) {
    return null;
  }

  const isDark = resolvedTheme === "dark";

  return createPortal(
    <button
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="kh-theme-toggle-btn"
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      type="button"
    >
      {isDark ? (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" fill="currentColor" />
        </svg>
      ) : (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.76 4.84l-1.8-1.79L3.17 4.84l1.79 1.8 1.8-1.8zM1 13h3v-2H1v2zm10 9h2v-3h-2v3zm7.24-2.84l1.79 1.79 1.79-1.79-1.79-1.8-1.79 1.8zM20 11v2h3v-2h-3zM12 5a7 7 0 100 14 7 7 0 000-14z" fill="currentColor" />
        </svg>
      )}
    </button>,
    portalRoot
  );
}
