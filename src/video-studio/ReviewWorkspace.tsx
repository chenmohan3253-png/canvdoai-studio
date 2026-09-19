import { useEffect, useMemo, useState } from "react";
import styles from "./VideoStudio.module.css";
import type { VideoRunReview, VideoStudioController } from "./types";

const KIND_LABELS = {
  CHARACTER: "角色",
  SCENE: "场景",
  PROP: "道具",
  SHOT: "分镜",
  KEYFRAME: "关键帧",
} as const;

const RISK_LABELS = {
  LOW: "低风险",
  MEDIUM: "需关注",
  HIGH: "高风险",
} as const;

export interface ReviewWorkspaceProps {
  review: VideoRunReview;
  controller: VideoStudioController;
}

export function ReviewWorkspace({ review, controller }: ReviewWorkspaceProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const regenerating = review.status === "REGENERATING";

  useEffect(() => {
    setSelectedIds([]);
    setInstruction("");
  }, [review.id]);

  const selectedCount = selectedIds.length;
  const highRiskCount = useMemo(() => review.items.filter((item) => item.risk === "HIGH").length, [review.items]);

  function toggleItem(itemId: string) {
    setSelectedIds((current) => current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId]);
  }

  return (
    <section className={`${styles.card} ${styles.reviewWorkspace}`} aria-labelledby="video-review-title">
      <div className={styles.reviewTopline}>
        {[1, 2, 3].map((gate) => (
          <div key={gate} className={`${styles.reviewGate} ${gate < review.gate ? styles.reviewGateDone : ""} ${gate === review.gate ? styles.reviewGateActive : ""}`}>
            <span>{gate < review.gate ? "✓" : gate}</span>
            <strong>{gate === 1 ? "视觉定妆" : gate === 2 ? "分镜脚本" : "关键帧"}</strong>
          </div>
        ))}
      </div>

      <div className={styles.reviewHeader}>
        <div>
          <span className={styles.kicker}>专业模式 · 强制审核点 {review.gate}/3</span>
          <h2 id="video-review-title">{review.title}</h2>
          <p>{review.guidance}</p>
        </div>
        <div className={styles.reviewVersion}>
          <span>当前审核版本</span>
          <strong>V{review.artifactVersion}</strong>
        </div>
      </div>

      <div className={styles.reviewSummary}>
        <span>待确认 {review.items.length} 项</span>
        <span className={highRiskCount ? styles.reviewWarning : ""}>{highRiskCount ? `${highRiskCount} 项高风险` : "未发现高风险"}</span>
        <span>已选 {selectedCount} 项重做</span>
        <span>本轮追加 {review.estimatedAdditionalPoints.toLocaleString()} 积分</span>
      </div>

      {regenerating ? <div className={styles.reviewRegenerating} role="status">正在局部重做已选项目，其他已确认内容不会改变…</div> : null}

      <div className={`${styles.reviewGrid} ${review.type === "STORYBOARD" ? styles.reviewGridList : ""}`}>
        {review.items.map((item, index) => {
          const selected = selectedIds.includes(item.id);
          return (
            <label key={item.id} className={`${styles.reviewItem} ${selected ? styles.reviewItemSelected : ""}`}>
              <input type="checkbox" checked={selected} disabled={controller.busy} onChange={() => toggleItem(item.id)} />
              <div className={styles.reviewVisual} data-kind={item.kind}>
                <span>{item.kind === "SHOT" ? String(index + 1).padStart(2, "0") : KIND_LABELS[item.kind].slice(0, 1)}</span>
                <i>{KIND_LABELS[item.kind]}</i>
              </div>
              <div className={styles.reviewItemBody}>
                <div className={styles.reviewItemTitle}>
                  <strong>{item.title}</strong>
                  <span className={`${styles.risk} ${styles[`risk${item.risk ?? "LOW"}`]}`}>{RISK_LABELS[item.risk ?? "LOW"]}</span>
                </div>
                <p>{item.description}</p>
                <small>{item.detail} · V{item.version}</small>
              </div>
              <span className={styles.reviewCheck}>{selected ? "待重做" : "保留"}</span>
            </label>
          );
        })}
      </div>

      <div className={styles.reviewActions}>
        <div className={styles.reviewInstructionWrap}>
          <label htmlFor="review-instruction">局部重做意见</label>
          <textarea
            id="review-instruction"
            className={styles.reviewInstruction}
            value={instruction}
            disabled={controller.busy}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：保持服装和发型不变，只调整人物年龄与表情…"
          />
        </div>
        <div className={styles.reviewButtons}>
          <button
            type="button"
            className={styles.secondary}
            disabled={controller.busy || selectedCount === 0}
            onClick={() => void controller.regenerateReview(review.id, selectedIds, instruction)}
          >
            {regenerating ? "正在重新生成…" : `重做已选 ${selectedCount || ""} 项`}
          </button>
          <button
            type="button"
            className={styles.reviewApprove}
            disabled={controller.busy || regenerating}
            onClick={() => void controller.approveReview(review.id)}
          >
            全部确认、锁定并继续
          </button>
          <small>确认后本版内容将被锁定；后续修改会使相关下游结果失效。</small>
        </div>
      </div>
    </section>
  );
}
