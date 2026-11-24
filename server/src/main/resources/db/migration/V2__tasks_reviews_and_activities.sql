CREATE TABLE tasks (
 id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL,
 title VARCHAR(120) NOT NULL, description TEXT NOT NULL,
 status ENUM('OPEN','ASSIGNED','IN_PROGRESS','IN_REVIEW','DONE','CANCELED') NOT NULL,
 assignee_id CHAR(36) NULL, due_at TIMESTAMP(6) NULL,
 version BIGINT NOT NULL DEFAULT 0, round_no INT NOT NULL DEFAULT 0,
 created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(assignee_id) REFERENCES app_users(id),
 INDEX idx_tasks_project(project_id,created_at),
 CHECK ((status='OPEN' AND assignee_id IS NULL) OR (status<>'OPEN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE task_rounds (
 task_id CHAR(36) NOT NULL, round_no INT NOT NULL, submitted_by CHAR(36) NOT NULL,
 summary TEXT NOT NULL, reviewer_id CHAR(36) NULL, opinion TEXT NULL,
 decision ENUM('PENDING','ACCEPTED','RETURNED','CANCELED') NOT NULL DEFAULT 'PENDING',
 reason TEXT NULL, decided_by CHAR(36) NULL,
 submitted_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), decided_at TIMESTAMP(6) NULL,
 PRIMARY KEY(task_id,round_no), FOREIGN KEY(task_id) REFERENCES tasks(id),
 FOREIGN KEY(submitted_by) REFERENCES app_users(id), FOREIGN KEY(reviewer_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE activities (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, project_id CHAR(36) NOT NULL, task_id CHAR(36) NULL,
 actor_id CHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL, detail TEXT NOT NULL,
 occurred_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(task_id) REFERENCES tasks(id),
 FOREIGN KEY(actor_id) REFERENCES app_users(id), INDEX idx_activity_project(project_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
