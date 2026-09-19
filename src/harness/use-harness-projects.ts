import { durableStorage } from "../desktop/storage";
import { useCallback, useEffect, useState } from "react";
import type { VideoProjectStatus, VideoProjectSummary } from "../video-studio/types";
import { DEMO_SCRIPT } from "./demo-data";

const PROJECTS_STORAGE_KEY = "canvdoai.harness.projects.v1";
const PROJECT_STORAGE_PREFIXES = [
  "canvdoai.preproduction.",
  "canvdoai.postproduction.",
  "canvdoai.image-test.",
  "canvdoai.harness.run.",
] as const;

function defaultProject(): VideoProjectSummary {
  const now = new Date().toISOString();
  return {
    id: "demo-project",
    name: "雷劈之后",
    description: "都市奇幻悬疑短片",
    status: "READY",
    script: DEMO_SCRIPT,
    createdAt: now,
    updatedAt: now,
  };
}

function isProject(value: unknown): value is VideoProjectSummary {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<VideoProjectSummary>;
  return typeof project.id === "string" && typeof project.name === "string" && typeof project.status === "string"
    && typeof project.createdAt === "string" && typeof project.updatedAt === "string";
}

export function loadHarnessProjects(): VideoProjectSummary[] {
  if (typeof window === "undefined") return [defaultProject()];
  try {
    const raw = durableStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [defaultProject()];
    const projects = JSON.parse(raw) as unknown;
    return Array.isArray(projects) && projects.every(isProject) ? projects : [defaultProject()];
  } catch {
    return [defaultProject()];
  }
}

export function removeHarnessProjectStorage(projectId: string) {
  if (typeof window === "undefined") return;
  for (const prefix of PROJECT_STORAGE_PREFIXES) durableStorage.removeItem(`${prefix}${projectId}`);
}

function projectId() {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `project-${Date.now().toString(36)}-${suffix}`;
}

export function useHarnessProjects() {
  const [projects, setProjects] = useState<VideoProjectSummary[]>(loadHarnessProjects);

  useEffect(() => {
    try {
      durableStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // 仅测试壳使用 localStorage；主站接入时由 Project API 持久化。
    }
  }, [projects]);

  const createProject = useCallback((name: string) => {
    const now = new Date().toISOString();
    const created: VideoProjectSummary = {
      id: projectId(),
      name: name.trim(),
      status: "DRAFT",
      script: "",
      createdAt: now,
      updatedAt: now,
    };
    setProjects((current) => [created, ...current]);
    return created;
  }, []);

  const updateProjectScript = useCallback((id: string, script: string) => {
    setProjects((current) => {
      let changed = false;
      const next = current.map((project) => {
        if (project.id !== id || project.script === script) return project;
        changed = true;
        return {
          ...project,
          script,
          status: script.trim() ? "READY" as const : "DRAFT" as const,
          updatedAt: new Date().toISOString(),
        };
      });
      return changed ? next : current;
    });
  }, []);

  const updateProjectRun = useCallback((id: string, status: VideoProjectStatus, latestRunId?: string) => {
    setProjects((current) => {
      let changed = false;
      const next = current.map((project) => {
        if (project.id !== id || (project.status === status && project.latestRunId === latestRunId)) return project;
        changed = true;
        return { ...project, status, latestRunId, updatedAt: new Date().toISOString() };
      });
      return changed ? next : current;
    });
  }, []);

  const deleteProject = useCallback((id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
    removeHarnessProjectStorage(id);
  }, []);

  return { projects, createProject, updateProjectScript, updateProjectRun, deleteProject };
}
