-- 0012_host_project_binding.sql — project ownership for managed instruction
-- blocks (closure design appendix M.1).
--
-- The instructions managed root belongs to a project. attach records the
-- project id derived from the project root realpath on the root registration;
-- the runtime reports the session working directory on `ready`, so the kernel
-- can bind a new task to the registered project. A session whose working
-- directory matches no registered project keeps `task.project_id = NULL` and
-- never receives instructions candidates.
ALTER TABLE host_runtime_session
  ADD COLUMN working_directory TEXT;

ALTER TABLE root_registration
  ADD COLUMN project_id TEXT;
