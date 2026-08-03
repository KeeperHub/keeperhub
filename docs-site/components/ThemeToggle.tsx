"use client";

import { useEffect, useRef, useState } from "react";

const THEME_KEY = "theme";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => {
    if (typeof window === "undefined") return "light";
    try {
      return (
        localStorage.getItem(THEME_KEY) ||
        (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      );
    } catch (e) {
      return "light";
    }
  });

  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    try {
      if (theme === "dark") document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // ignore
    }
  }, [theme]);

  // On mount, attempt to insert the toggle button before the search element in the navbar
  useEffect(() => {
    try {
      const insertAfterGitHub = () => {
        const btn = btnRef.current;
        if (!btn) return false;

        // Prefer explicit GitHub link in navbar
        const github = document.querySelector('.nextra-navbar a[href*="github.com"]');
        if (github && github.parentElement) {
          let wrapper = github.parentElement.querySelector('.kh-theme-toggle');
          if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'kh-theme-toggle';
            // insert wrapper after the github element
            if (github.nextSibling) github.parentElement.insertBefore(wrapper, github.nextSibling);
            else github.parentElement.appendChild(wrapper);
          }
          if (btn.parentElement !== wrapper) wrapper.appendChild(btn);
          return true;
        }

        // Fallback: append to right-side actions container (last child of navbar)
        const right = document.querySelector('.nextra-navbar > div:last-child');
        if (right) {
          let wrapper = right.querySelector('.kh-theme-toggle');
          if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'kh-theme-toggle';
            right.insertBefore(wrapper, right.firstChild);
          }
          if (btn.parentElement !== wrapper) wrapper.appendChild(btn);
          return true;
        }

        return false;
      };

      if (!insertAfterGitHub()) {
        const observer = new MutationObserver(() => {
          if (insertAfterGitHub()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 5000);
      }
    } catch (e) {
      // ignore
    }
  }, []);

  function toggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <button
      ref={btnRef}
      onClick={toggle}
      className="kh-theme-toggle-btn"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
      type="button"
    >
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" fill="currentColor" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.76 4.84l-1.8-1.79L3.17 4.84l1.79 1.8 1.8-1.8zM1 13h3v-2H1v2zm10 9h2v-3h-2v3zm7.24-2.84l1.79 1.79 1.79-1.79-1.79-1.8-1.79 1.8zM20 11v2h3v-2h-3zM12 5a7 7 0 100 14 7 7 0 000-14z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}
