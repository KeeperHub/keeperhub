"use client";

import { useEffect, useMemo, useState } from "react";

type UsePaginationOptions = {
  defaultItemsPerPage?: number;
  defaultPage?: number;
};

type UsePaginationReturn<T> = {
  paginatedItems: T[];
  totalPages: number;
  currentPage: number;
  itemsPerPage: number;
  setCurrentPage: (page: number) => void;
  setItemsPerPage: (size: number) => void;
  goToNextPage: () => void;
  goToPreviousPage: () => void;
  goToPage: (page: number) => void;
  canGoNext: boolean;
  canGoPrevious: boolean;
  showingFrom: number;
  showingTo: number;
  totalItems: number;
  pageNumbers: (number | string)[];
};

export function usePagination<T>(
  items: T[],
  options?: UsePaginationOptions
): UsePaginationReturn<T> {
  const defaultItemsPerPage = options?.defaultItemsPerPage ?? 10;
  const defaultPage = options?.defaultPage ?? 1;

  const [currentPage, setCurrentPage] = useState(defaultPage);
  const [itemsPerPage, setItemsPerPageState] = useState(defaultItemsPerPage);

  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);

  useEffect(() => {
    if (totalPages > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    } else if (totalPages === 0 && currentPage > 1) {
      setCurrentPage(1);
    }
  }, [totalPages, currentPage]);

  const paginatedItems = useMemo(() => {
    if (totalItems === 0) {
      return [];
    }

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return items.slice(startIndex, endIndex);
  }, [items, currentPage, itemsPerPage, totalItems]);

  const showingFrom = useMemo(() => {
    if (totalItems === 0) {
      return 0;
    }
    return (currentPage - 1) * itemsPerPage + 1;
  }, [currentPage, itemsPerPage, totalItems]);

  const showingTo = useMemo(() => {
    if (totalItems === 0) {
      return 0;
    }
    const endIndex = currentPage * itemsPerPage;
    return Math.min(endIndex, totalItems);
  }, [currentPage, itemsPerPage, totalItems]);

  // Navigation helpers
  const canGoNext = currentPage < totalPages;
  const canGoPrevious = currentPage > 1;

  const goToNextPage = () => {
    if (canGoNext) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const goToPreviousPage = () => {
    if (canGoPrevious) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(validPage);
  };

  const setItemsPerPage = (size: number) => {
    setItemsPerPageState(size);
    setCurrentPage(1);
  };

  // Calculate page numbers to display
  const pageNumbers = useMemo(() => {
    const pages: (number | string)[] = [];
    const maxVisible = 5; // Show current ± 2 pages

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
      return pages;
    }

    // Always show first page
    pages.push(1);

    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);

    if (start > 2) {
      pages.push("ellipsis-start");
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (end < totalPages - 1) {
      pages.push("ellipsis-end");
    }

    if (totalPages > 1) {
      pages.push(totalPages);
    }

    return pages;
  }, [currentPage, totalPages]);

  return {
    paginatedItems,
    totalPages,
    currentPage,
    itemsPerPage,
    setCurrentPage: goToPage,
    setItemsPerPage,
    goToNextPage,
    goToPreviousPage,
    goToPage,
    canGoNext,
    canGoPrevious,
    showingFrom,
    showingTo,
    totalItems,
    pageNumbers,
  };
}
