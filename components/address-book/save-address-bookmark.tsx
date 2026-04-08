"use client";

import { ethers } from "ethers";
import { useAtomValue, useSetAtom } from "jotai";
import { useStore } from "jotai/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AddAddressOverlay } from "@/components/overlays/address-book-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  ADDRESS_BOOK_SELECTION_KEY,
  parseAddressBookSelection,
} from "@/lib/address-book-selection";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { addressBookApi, api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import {
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
  type WorkflowNode,
} from "@/lib/workflow-store";
import { AddressSelectPopover } from "./address-select-popover";
import { SaveAddressButton } from "./save-address-button";

const BLUR_DELAY_MS = 200;

function isFocusInsidePopoverOrCommand(): boolean {
  const active = document.activeElement;
  return (
    Boolean(active?.closest('[data-slot="popover-content"]')) ||
    Boolean(active?.closest('[data-slot="command"]'))
  );
}

type SaveAddressBookmarkProps = {
  address?: string;
  children: React.ReactElement<{
    value?: string;
    onChange?: (value: string) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
  }>;
  fieldKey?: string;
  nodeId?: string;
  selectedBookmarkId?: string;
};

export function SaveAddressBookmark({
  address: addressProp,
  children,
  fieldKey,
  nodeId,
  selectedBookmarkId,
}: SaveAddressBookmarkProps) {
  const { data: session } = useSession();
  const { push } = useOverlay();
  const store = useStore();
  const selectedNodeIdFromStore = useAtomValue(selectedNodeAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const effectiveNodeId = nodeId ?? selectedNodeIdFromStore ?? undefined;
  const [currentAddress, setCurrentAddress] = useState<string>("");
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [optimisticBookmarkId, setOptimisticBookmarkId] = useState<
    string | undefined
  >(undefined);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistBookmarkSelectionToApi = useCallback(
    (bookmarkId: string, targetNodeId: string, targetFieldKey: string) => {
      const nodeList = store.get(nodesAtom);
      const node = nodeList.find((n: WorkflowNode) => n.id === targetNodeId);
      if (!node) {
        return;
      }

      const workflowId = store.get(currentWorkflowIdAtom);
      if (!workflowId) {
        return;
      }

      const config = node.data.config ?? {};
      const selectionMap = parseAddressBookSelection(config);
      const nextSelectionMap = {
        ...selectionMap,
        [targetFieldKey]: bookmarkId,
      };
      const newConfig = {
        ...config,
        [ADDRESS_BOOK_SELECTION_KEY]: JSON.stringify(nextSelectionMap),
      };

      updateNodeData({ id: targetNodeId, data: { config: newConfig } });

      const currentEdges = store.get(edgesAtom);
      const newNodes = nodeList.map((n) =>
        n.id === targetNodeId
          ? { ...n, data: { ...n.data, config: newConfig } }
          : n
      );

      const doUpdate = () =>
        api.workflow
          .update(workflowId, { nodes: newNodes, edges: currentEdges })
          .then(() => setHasUnsavedChanges(false))
          .catch((err) => {
            console.error("Failed to persist address book selection:", err);
          });

      persistQueueRef.current = persistQueueRef.current.then(
        doUpdate,
        doUpdate
      );
    },
    [store, updateNodeData, setHasUnsavedChanges]
  );

  const isTemporalAccount =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.startsWith("temp-");

  useEffect(() => {
    const childValue = children.props.value;
    const raw = childValue === undefined ? addressProp : childValue;
    if (raw !== undefined) {
      const stored = ethers.isAddress(raw)
        ? normalizeAddressForStorage(raw)
        : raw;
      setCurrentAddress(stored);
    }
  }, [children.props.value, addressProp]);

  const address = addressProp ?? currentAddress;

  const scheduleClosePopoverIfBlurred = useCallback(() => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      if (!isFocusInsidePopoverOrCommand()) {
        setIsInputFocused(false);
      }
    }, BLUR_DELAY_MS);
  }, []);

  const childWithInterception = React.cloneElement(children, {
    onChange: (value: string) => {
      const stored = ethers.isAddress(value)
        ? normalizeAddressForStorage(value)
        : value;
      setCurrentAddress(stored);
      children.props.onChange?.(stored);
    },
    onFocus: (e: React.FocusEvent) => {
      if (!isTemporalAccount) {
        setIsInputFocused(true);
      }
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      scheduleClosePopoverIfBlurred();
      children.props.onBlur?.(e);
    },
  });

  useEffect(() => {
    const container = inputContainerRef.current;
    if (!container) {
      return;
    }

    const handleFocus = () => {
      if (!isTemporalAccount) {
        setIsInputFocused(true);
      }
    };
    container.addEventListener("focusin", handleFocus);
    container.addEventListener("focusout", scheduleClosePopoverIfBlurred);

    return () => {
      container.removeEventListener("focusin", handleFocus);
      container.removeEventListener("focusout", scheduleClosePopoverIfBlurred);
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
      }
    };
  }, [isTemporalAccount, scheduleClosePopoverIfBlurred]);

  const handleAddressSelect = (selectedAddress: string, bookmarkId: string) => {
    const stored = ethers.isAddress(selectedAddress)
      ? normalizeAddressForStorage(selectedAddress)
      : selectedAddress;
    children.props.onChange?.(stored);
    setCurrentAddress(stored);
    setIsInputFocused(false);
    setOptimisticBookmarkId(bookmarkId);

    if (effectiveNodeId && fieldKey) {
      persistBookmarkSelectionToApi(bookmarkId, effectiveNodeId, fieldKey);
    }
  };

  useEffect(() => {
    if (selectedBookmarkId !== undefined) {
      setOptimisticBookmarkId(undefined);
    }
  }, [selectedBookmarkId]);

  const handleSaveClick = () => {
    if (!(address && ethers.isAddress(address))) {
      toast.error("Please enter a valid Ethereum address first");
      return;
    }

    push(AddAddressOverlay, {
      initialAddress: address,
      onSave: async (label: string, addr: string) => {
        await addressBookApi.create({ label, address: addr });
      },
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1" ref={inputContainerRef}>
          <AddressSelectPopover
            isOpen={isInputFocused && !isTemporalAccount}
            onAddressSelect={handleAddressSelect}
            onClose={() => setIsInputFocused(false)}
            selectedBookmarkId={
              selectedBookmarkId ?? optimisticBookmarkId ?? undefined
            }
          >
            {childWithInterception}
          </AddressSelectPopover>
        </div>
        {!isTemporalAccount && (
          <SaveAddressButton
            address={currentAddress}
            onClick={handleSaveClick}
          />
        )}
      </div>
    </div>
  );
}
