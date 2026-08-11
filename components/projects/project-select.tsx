"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Project } from "@/lib/api-client";
import { ProjectFormDialog } from "./project-form-dialog";

const NONE_VALUE = "__none__";
const NEW_VALUE = "__new__";

type ProjectSelectProps = {
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
};

export function ProjectSelect({
  value,
  onChange,
  disabled,
}: ProjectSelectProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.project.getAll();
      setProjects(result);
    } catch {
      // silently fail - projects are optional
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleValueChange = (val: string) => {
    if (val === NEW_VALUE) {
      setShowCreateDialog(true);
      return;
    }
    onChange(val === NONE_VALUE ? null : val);
  };

  const handleProjectCreated = (project: Project) => {
    setProjects((prev) => [...prev, project]);
    onChange(project.id);
  };

  return (
    <>
      <Select
        disabled={disabled}
        onValueChange={handleValueChange}
        value={value ?? NONE_VALUE}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select project..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex items-center gap-2">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: project.color ?? "var(--color-text-muted)",
                  }}
                />
                {project.name}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={NEW_VALUE}>
            <span className="flex items-center gap-2">
              <Plus className="size-3.5" />
              New Project
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      <ProjectFormDialog
        onCreated={handleProjectCreated}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />
    </>
  );
}
