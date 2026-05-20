terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
}


resource "kubernetes_namespace_v1" "todo_app" {
  metadata {
    name = "todo-app"
  }
}

resource "kubernetes_deployment_v1" "mysql" {
  metadata {
    name      = "mysql"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "mysql"
      }
    }

    template {
      metadata {
        labels = {
          app = "mysql"
        }
      }

      spec {
        container {
          name  = "mysql"
          image = "mysql:8.4"

          port {
            container_port = 3306
          }

          env {
            name  = "MYSQL_ROOT_PASSWORD"
            value = "rootpass"
          }
          env {
            name  = "MYSQL_DATABASE"
            value = "mydb"
          }
          env {
            name  = "MYSQL_USER"
            value = "iseeanoob"
          }
          env {
            name  = "MYSQL_PASSWORD"
            value = "pass"
          }

          volume_mount {
            name       = "mysql-data"
            mount_path = "/var/lib/mysql"
          }
        }

        volume {
          name = "mysql-data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.mysql_pvc.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_persistent_volume_claim_v1" "mysql_pvc" {
  metadata {
    name      = "mysql-pvc"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  wait_until_bound = false
  spec {
    access_modes = ["ReadWriteOnce"]

    resources {
      requests = {
        storage = "1Gi"
      }
    }
  }
}

resource "kubernetes_service_v1" "mysql_service" {
  metadata {
    name      = "db"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    selector = {
      app = "mysql"
    }

    port {
      port        = 3306
      target_port = 3306
    }

    type = "ClusterIP"
  }
}

resource "kubernetes_deployment_v1" "todo_app" {
  metadata {
    name      = "todo-app"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "todo-app"
      }
    }

    template {
      metadata {
        labels = {
          app = "todo-app"
        }
      }

      spec {
        container {
          name  = "todo-app"
          image = "iseeanoob/todo-app:latest"
          image_pull_policy = "Always"

          port {
            container_port = 3001
          }

          env {
            name  = "DB_HOST"
            value = "db"
          }
          env {
            name  = "DB_USER"
            value = "iseeanoob"
          }
          env {
            name  = "DB_PASSWORD"
            value = "pass"
          }
          env {
            name  = "DB_NAME"
            value = "mydb"
          }
          env {
            name  = "JWT_SECRET"
            value = "your_jwt_secret"   # change this to something secure
          }
          env {
            name  = "PORT"
            value = "3001"
          }
        }
      }
    }
  }

  depends_on = [kubernetes_deployment_v1.mysql]
}

resource "kubernetes_service_v1" "todo_app_service" {
  metadata {
    name      = "todo-app-service"
    namespace = kubernetes_namespace_v1.todo_app.metadata[0].name
  }

  spec {
    selector = {
      app = "todo-app"
    }

    port {
      port        = 80
      target_port = 3001
      node_port   = 30080
    }

    type = "NodePort"
  }
}

locals {
  flux_cluster_directory = "${path.module}/${var.flux_cluster_path}"

  flux_components_documents = [
    for doc in split("\n---", file("${local.flux_cluster_directory}/flux-system/gotk-components.yaml")) :
    trimspace(trimprefix(doc, "---"))
    if trimspace(trimprefix(doc, "---")) != ""
  ]

  flux_components_manifests = [
    for doc in local.flux_components_documents :
    yamldecode(doc)
  ]

  flux_sync_documents = [
    for doc in split("\n---", file("${local.flux_cluster_directory}/flux-system/gotk-sync.yaml")) :
    trimspace(trimprefix(doc, "---"))
    if trimspace(trimprefix(doc, "---")) != ""
  ]

  flux_sync_manifests = [
    for doc in local.flux_sync_documents :
    yamldecode(doc)
  ]

  flux_sync_manifests_overridden = [
    for manifest in local.flux_sync_manifests : (
      manifest.kind == "GitRepository" ? merge(manifest, {
        spec = merge(manifest.spec, {
          url = var.flux_git_repository_url
          ref = merge(try(manifest.spec.ref, {}), {
            branch = var.flux_git_branch
          })
        })
      }) : (
        manifest.kind == "Kustomization" ? merge(manifest, {
          spec = merge(manifest.spec, {
            path = var.flux_kustomization_path
          })
        }) : manifest
      )
    )
  ]
}

resource "kubernetes_manifest" "flux_components" {
  for_each = {
    for index, manifest in local.flux_components_manifests :
    format("%05d-%s-%s-%s", index, lower(manifest.kind), lower(manifest.metadata.name), lower(try(manifest.metadata.namespace, "cluster"))) => manifest
  }

  manifest = each.value
}

resource "kubernetes_manifest" "flux_sync" {
  for_each = {
    for index, manifest in local.flux_sync_manifests_overridden :
    format("%05d-%s-%s-%s", index, lower(manifest.kind), lower(manifest.metadata.name), lower(try(manifest.metadata.namespace, "cluster"))) => manifest
  }

  manifest = each.value

  depends_on = [kubernetes_manifest.flux_components]
}
