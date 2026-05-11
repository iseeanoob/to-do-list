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
    }

    type = "NodePort"
  }
}