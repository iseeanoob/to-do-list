variable "ext_port" {
  description = "The external port for Nginx"
  type        = number
  default     = 8000
}

variable "flux_git_repository_url" {
  description = "Git repository URL used by Flux GitRepository."
  type        = string
  default     = "https://github.com/iseeanoob/to-do-list"
}

variable "flux_git_branch" {
  description = "Git branch used by Flux GitRepository."
  type        = string
  default     = "main"
}

variable "flux_kustomization_path" {
  description = "Repository path used by Flux Kustomization."
  type        = string
  default     = "./clusters/my-cluster"
}
