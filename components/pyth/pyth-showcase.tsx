"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Database,
  Github,
  Radio,
  RefreshCw,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import { Button } from "@/components/ui/button";
import { PYTH_FEATURE_PR } from "@/lib/pyth/demo-evidence";
import { CreateTrigger } from "./create-trigger";
import { EvidencePanel } from "./evidence-panel";
import styles from "./showcase.module.css";

function Reveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 28 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
      viewport={{ once: true, amount: 0.12 }}
      whileInView={{ opacity: 1, y: 0 }}
    >
      {children}
    </motion.div>
  );
}

const contours = Array.from({ length: 15 }, (_, index) => ({
  rx: 130 + index * 14,
  ry: 65 + index * 12,
}));

const capabilities = [
  {
    number: "01",
    icon: Radio,
    title: "Listen to the signal.",
    text: "Stream prices from Pyth Hermes. Choose a feed, a threshold, and the direction that matters to your workflow.",
    label: "STREAMING PRICE FEEDS",
  },
  {
    number: "02",
    icon: ShieldCheck,
    title: "Make the crossing count.",
    text: "Reject stale updates and suppress duplicates. A rearm price keeps movement around your threshold from repeatedly firing.",
    label: "EXPLICIT REARM RULES",
  },
  {
    number: "03",
    icon: RefreshCw,
    title: "Keep the work moving.",
    text: "Persist checkpoints and pending executions. Recover queue delivery after an interruption, with a fresh baseline when a stream restarts.",
    label: "RECOVERABLE DELIVERY",
  },
];

export function PythShowcase() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <header className={styles.header}>
        <Link
          aria-label="KeeperHub Pyth home"
          className={styles.brand}
          href="/pyth"
        >
          <span className={styles.brandMark}>
            <KeeperHubLogo className={styles.logo} />
          </span>
          KeeperHub
          <span className={styles.brandDivider} />{" "}
          <span className={styles.brandSub}>Pyth triggers</span>
        </Link>
        <nav aria-label="Pyth feature navigation" className={styles.nav}>
          <a href="#how-it-works">How it works</a>
          <a href="#proof">The proof</a>
          <a href={PYTH_FEATURE_PR} rel="noopener noreferrer" target="_blank">
            GitHub <ArrowUpRight size={13} />
          </a>
        </nav>
        <Button asChild className={styles.headerButton}>
          <a href="#build">
            Build a trigger <ArrowUpRight size={15} />
          </a>
        </Button>
      </header>
      <main id="main-content">
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div aria-hidden="true" className={styles.heroGlow} />
          <svg
            aria-hidden="true"
            className={styles.contours}
            fill="none"
            viewBox="0 0 700 700"
          >
            {contours.map((contour) => (
              <ellipse
                cx="230"
                cy="270"
                key={contour.rx}
                rx={contour.rx}
                ry={contour.ry}
                transform="rotate(-36 230 270)"
              />
            ))}
          </svg>
          <Reveal className={styles.heroCopy}>
            <span className={styles.eyebrow}>
              <span className={styles.statusDot} /> INTRODUCING NATIVE PYTH
              TRIGGERS
            </span>
            <h1 id="hero-title">
              When price moves,
              <br />
              <span>your workflow follows.</span>
            </h1>
            <p>
              Turn a Pyth price crossing into a KeeperHub workflow.
              <br className={styles.desktopBreak} /> Streaming signals.
              Persistent state. Execution you can inspect.
            </p>
            <div className={styles.heroActions}>
              <Button asChild className={styles.primaryButton}>
                <a href="#build">
                  Build your first trigger <ArrowUpRight size={17} />
                </a>
              </Button>
              <Button
                asChild
                className={styles.secondaryButton}
                variant="ghost"
              >
                <a href="#proof">
                  Explore the verified run <ArrowDown size={16} />
                </a>
              </Button>
            </div>
            <span className={styles.heroNote}>
              Built for the Agent Economy · KeeperHub feature contribution
            </span>
          </Reveal>
          <Reveal className={styles.heroVisual}>
            <div className={styles.floatingLabel}>
              <span className={styles.iconTile}>
                <Radio size={17} />
              </span>
              <div>
                <strong>A price is a signal.</strong>
                <span>Give it a workflow.</span>
              </div>
              <span className={styles.smallDot} />
            </div>
            <div className={styles.perspectivePanel}>
              <EvidencePanel compact />
            </div>
            <div className={styles.floatingProof}>
              <ShieldCheck size={19} />
              <div>
                <strong>One crossing. One action.</strong>
                <span>Verified in the recorded local run.</span>
              </div>
              <Check size={15} />
            </div>
          </Reveal>
          <div className={styles.stackStrip}>
            <span>THE EXECUTION PATH</span>
            <div>
              <Radio size={16} /> Pyth Hermes
            </div>
            <ArrowRight size={14} />
            <div>
              <Database size={16} /> PostgreSQL
            </div>
            <ArrowRight size={14} />
            <div>
              <Zap size={16} /> SQS
            </div>
            <ArrowRight size={14} />
            <div>
              <Workflow size={16} /> KeeperHub
            </div>
          </div>
        </section>
        <section
          aria-labelledby="how-title"
          className={styles.section}
          id="how-it-works"
        >
          <Reveal className={styles.sectionHeading}>
            <span className={styles.eyebrow}>FROM SIGNAL TO ACTION</span>
            <h2 id="how-title">
              A little less polling.
              <br />
              <span>A lot more purpose.</span>
            </h2>
            <p>
              Your agent decides what matters. A native trigger watches for the
              price crossing and hands the work to KeeperHub.
            </p>
          </Reveal>
          <div className={styles.capabilities}>
            {capabilities.map((item) => (
              <Reveal className={styles.capability} key={item.number}>
                <div className={styles.cardTop}>
                  <span className={styles.iconTile}>
                    <item.icon size={24} />
                  </span>
                  <span>{item.number}</span>
                </div>
                <span className={styles.micro}>{item.label}</span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                <div aria-hidden="true" className={styles.cardLine}>
                  <span />
                </div>
              </Reveal>
            ))}
          </div>
        </section>
        <section
          aria-labelledby="proof-title"
          className={`${styles.section} ${styles.proofSection}`}
          id="proof"
        >
          <Reveal className={styles.proofCopy}>
            <span className={styles.eyebrow}>LESS PROMISE. MORE PROOF.</span>
            <h2 id="proof-title">
              Follow the signal.
              <br />
              <span>Inspect the result.</span>
            </h2>
            <p>
              This replay uses evidence from a real local run on September 10,
              2026: a live ETH/USD update, a native crossing, and a completed
              Math action.
            </p>
            <p className={styles.proofDisclaimer}>
              Recorded evidence, not a live market dashboard. No onchain
              transaction was sent in this demonstration.
            </p>
            <div className={styles.proofStats}>
              <div>
                <strong>2</strong>
                <span>signed redeliveries</span>
              </div>
              <div>
                <strong>1</strong>
                <span>completed action</span>
              </div>
            </div>
            <a
              className={styles.textLink}
              href={PYTH_FEATURE_PR}
              rel="noopener noreferrer"
              target="_blank"
            >
              Review the implementation <ArrowUpRight size={16} />
            </a>
          </Reveal>
          <Reveal className={styles.proofPanel}>
            <EvidencePanel />
          </Reveal>
        </section>
        <section
          aria-labelledby="build-title"
          className={`${styles.section} ${styles.buildSection}`}
          id="build"
        >
          <Reveal className={styles.buildCopy}>
            <span className={styles.eyebrow}>YOUR SIGNAL. YOUR NEXT MOVE.</span>
            <h2 id="build-title">
              Start with a price.
              <br />
              <span>Build what comes next.</span>
            </h2>
            <p>
              Set your crossing rule, then open the native editor to connect the
              actions your workflow needs.
            </p>
            <ul className={styles.buildChecklist}>
              <li>
                <Check size={17} /> A Pyth trigger with your own thresholds
              </li>
              <li>
                <Check size={17} /> A Math action to inspect the observed price
              </li>
              <li>
                <Check size={17} /> Disabled until you review and enable it
              </li>
            </ul>
            <div className={styles.buildCallout}>
              <Workflow size={20} />
              <p>
                Already using KeeperHub?
                <br />
                <span>
                  Add a <strong>Pyth Price</strong> trigger from the workflow
                  editor.
                </span>
              </p>
            </div>
          </Reveal>
          <Reveal>
            <CreateTrigger />
          </Reveal>
        </section>
        <Reveal className={styles.closing}>
          <span className={styles.eyebrow}>BUILT IN THE OPEN</span>
          <h2>
            The signal is just
            <br />
            <span>the beginning.</span>
          </h2>
          <p>
            Explore the code. Inspect the evidence. Make the next workflow
            yours.
          </p>
          <Button asChild className={styles.primaryButton}>
            <a href={PYTH_FEATURE_PR} rel="noopener noreferrer" target="_blank">
              <Github size={17} /> Explore the pull request{" "}
              <ArrowUpRight size={17} />
            </a>
          </Button>
        </Reveal>
      </main>
      <footer className={styles.footer}>
        <Link className={styles.brand} href="/pyth">
          <span className={styles.brandMark}>
            <KeeperHubLogo className={styles.logo} />
          </span>
          KeeperHub
        </Link>
        <span>Native Pyth triggers · Agent Economy hackathon</span>
        <a href={PYTH_FEATURE_PR} rel="noopener noreferrer" target="_blank">
          Feature PR #2363 <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}
