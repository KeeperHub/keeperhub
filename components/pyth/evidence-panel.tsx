"use client";

import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Database,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PYTH_EVIDENCE_URL,
  pythDemoEvidence as proof,
} from "@/lib/pyth/demo-evidence";
import styles from "./showcase.module.css";

const stages = [
  {
    name: "Price received",
    icon: Radio,
    label: "PYTH HERMES",
    text: "The feed published a price above the configured threshold.",
  },
  {
    name: "Crossing accepted",
    icon: Database,
    label: "DURABLE CHECKPOINT",
    text: "The trigger recorded its checkpoint and pending execution before queue delivery.",
  },
  {
    name: "Action completed",
    icon: Check,
    label: "KEEPERHUB EXECUTOR",
    text: "The Math action recorded the observed USD price. Two redeliveries did not run it again.",
  },
] as const;

export function EvidencePanel({ compact = false }: { compact?: boolean }) {
  const reducedMotion = useReducedMotion();
  const [stage, setStage] = useState(2);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) {
      return;
    }
    if (stage === 2) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setStage((value) => value + 1),
      reducedMotion ? 150 : 1400
    );
    return () => window.clearTimeout(timer);
  }, [playing, stage, reducedMotion]);

  const replay = () => {
    setStage(0);
    setPlaying(true);
  };
  const active = stages[stage];

  return (
    <div
      className={`${styles.console} ${compact ? styles.consoleCompact : ""}`}
    >
      <div className={styles.consoleBar}>
        <span className={styles.consoleBrand}>
          <Workflow size={17} /> Price-triggered workflow
        </span>
        <span className={styles.recordedBadge}>RECORDED RUN · 10 SEP 2026</span>
      </div>
      <div className={styles.consoleBody}>
        <div className={styles.feedHeading}>
          <div className={styles.assetIcon}>
            <Radio size={24} />
          </div>
          <div>
            <span className={styles.micro}>ORACLE PRICE FEED</span>
            <h3>
              ETH <span>/ USD</span>
            </h3>
          </div>
          <span className={styles.successBadge}>
            <Check size={12} /> Verified
          </span>
        </div>
        <div className={styles.priceRow}>
          <div>
            <span className={styles.micro}>OBSERVED PRICE</span>
            <p className={styles.price}>
              $
              {Number(proof.price).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              <span> USD</span>
            </p>
          </div>
          <div className={styles.crossingTag}>
            <ArrowUpRight size={15} /> Above threshold
          </div>
        </div>
        <div className={styles.priceComparison}>
          <div>
            <span>Threshold</span>
            <strong>${Number(proof.threshold).toFixed(2)}</strong>
          </div>
          <div aria-hidden="true" className={styles.comparisonTrack}>
            <span />
            <i />
            <b />
          </div>
          <div>
            <span>Recorded result</span>
            <strong>${Number(proof.price).toFixed(2)}</strong>
          </div>
        </div>
        <p className={styles.comparisonCaption}>
          Recorded values · schematic threshold comparison
        </p>
        <fieldset
          aria-label="Recorded execution stages"
          className={styles.pipeline}
        >
          {stages.map((item, index) => (
            <div className={styles.pipelineItem} key={item.name}>
              <Button
                aria-pressed={stage === index}
                className={`${styles.pipelineNode} ${index <= stage ? styles.pipelineNodeActive : ""}`}
                onClick={() => {
                  setPlaying(false);
                  setStage(index);
                }}
                variant="ghost"
              >
                <item.icon size={19} />
                <span>{item.name}</span>
                <small>0{index + 1}</small>
              </Button>
              {index < 2 && (
                <div
                  aria-hidden="true"
                  className={`${styles.pipelineConnector} ${index < stage ? styles.connectorActive : ""}`}
                >
                  <ArrowDown size={13} />
                </div>
              )}
            </div>
          ))}
        </fieldset>
        <div aria-live="polite" className={styles.stageDetail}>
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
              key={stage}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
            >
              <span className={styles.micro}>{active.label}</span>
              <p>{active.text}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <div className={styles.consoleFooter}>
        <span>
          <ShieldCheck size={15} /> {proof.duplicateDeliveries} redeliveries.{" "}
          {proof.actionCount} action.
        </span>
        <Button
          className={styles.replayButton}
          disabled={playing}
          onClick={replay}
          size="sm"
          variant="ghost"
        >
          {playing ? <RotateCcw size={14} /> : <Play size={14} />}{" "}
          {playing ? "Replaying…" : "Replay verified run"}
        </Button>
      </div>
      {!compact && (
        <div className={styles.evidenceMeta}>
          <span>
            Execution <code>{proof.executionId}</code>
          </span>
          <a href={PYTH_EVIDENCE_URL} rel="noopener noreferrer" target="_blank">
            Inspect source evidence <ArrowUpRight size={14} />
          </a>
        </div>
      )}
    </div>
  );
}
