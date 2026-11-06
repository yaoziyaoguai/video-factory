// 运行时校验用的唯一 Schema 来源副本；由 contracts/agent/v1/verify.mjs 生成，勿手改。
export const contractsSchema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://frame.invalid/contracts/v1/payloads",
  "title": "Frame contract payloads 0.1.32",
  "$defs": {
    "FreeServiceSettings": {
      "oneOf": [
        {
          "$ref": "#/$defs/PexelsSettings"
        },
        {
          "$ref": "#/$defs/KeyedMaterialSettings"
        },
        {
          "$ref": "#/$defs/KeylessMaterialSettings"
        },
        {
          "$ref": "#/$defs/NewsNowSettings"
        }
      ]
    },
    "Id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"
    },
    "Digest": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "Cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "MaterialCandidate": {
      "type": "object",
      "properties": {
        "candidateId": {
          "$ref": "#/$defs/Id"
        },
        "provider": {
          "$ref": "#/$defs/MaterialProvider"
        },
        "providerAssetId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "kind": {
          "type": "string",
          "enum": [
            "image",
            "video",
            "audio"
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "sourceUrl": {
          "type": "string",
          "minLength": 8,
          "maxLength": 2048
        },
        "creatorName": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            {
              "type": "null"
            }
          ]
        },
        "creatorUrl": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 8,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "previewUrl": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 8,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "width": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            },
            {
              "type": "null"
            }
          ]
        },
        "height": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            },
            {
              "type": "null"
            }
          ]
        },
        "dimensionsKind": {
          "type": "string",
          "enum": [
            "source",
            "download"
          ],
          "description": "width/height 的语义：source 为来源原作，download 为当前可采用变体。旧批次缺省时仅在已有提供方事实能证明含义时标注，不把未知尺寸当作实际采用尺寸。"
        },
        "durationMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 86400000
            },
            {
              "type": "null"
            }
          ]
        },
        "licenseUrl": {
          "type": "string",
          "minLength": 8,
          "maxLength": 2048
        },
        "licenseName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "attributionText": {
          "type": "string",
          "minLength": 1,
          "maxLength": 3000
        },
        "usageScope": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "licenseVersion": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            {
              "type": "null"
            }
          ]
        },
        "vocalKind": {
          "type": "string",
          "enum": [
            "instrumental",
            "song",
            "unknown"
          ]
        },
        "lyricsLanguage": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "candidateId",
        "provider",
        "providerAssetId",
        "kind",
        "title",
        "sourceUrl",
        "creatorName",
        "creatorUrl",
        "previewUrl",
        "width",
        "height",
        "durationMs",
        "licenseUrl"
      ],
      "additionalProperties": false
    },
    "MaterialSearchResult": {
      "type": "object",
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MaterialCandidate"
          },
          "minItems": 0,
          "maxItems": 10
        },
        "retrievedAt": {
          "$ref": "#/$defs/Time"
        },
        "batchId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "results",
        "retrievedAt",
        "batchId"
      ],
      "additionalProperties": false
    },
    "MaterialImportResult": {
      "type": "object",
      "properties": {
        "blobId": {
          "$ref": "#/$defs/Id"
        },
        "digest": {
          "$ref": "#/$defs/Digest"
        },
        "mimeType": {
          "type": "string",
          "enum": [
            "video/mp4",
            "video/webm",
            "image/png",
            "image/jpeg",
            "audio/mpeg",
            "audio/wav"
          ]
        },
        "durationMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 86400000
            },
            {
              "type": "null"
            }
          ]
        },
        "provenance": {
          "$ref": "#/$defs/MediaProvenance"
        },
        "dimensions": {
          "type": "object",
          "properties": {
            "width": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            },
            "height": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            }
          },
          "required": [
            "width",
            "height"
          ],
          "additionalProperties": false,
          "description": "首次采用时探测到的实际文件像素；重复采用返回同一次测量。旧记录没有实测值时省略，不采用候选原作尺寸推算。"
        }
      },
      "required": [
        "blobId",
        "digest",
        "mimeType",
        "durationMs",
        "provenance"
      ],
      "additionalProperties": false
    },
    "MediaProvenance": {
      "type": "object",
      "properties": {
        "provider": {
          "$ref": "#/$defs/MaterialProvider"
        },
        "assetId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "sourceUrl": {
          "type": "string",
          "minLength": 8,
          "maxLength": 2048
        },
        "creatorName": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            {
              "type": "null"
            }
          ]
        },
        "creatorUrl": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 8,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "licenseUrl": {
          "type": "string",
          "minLength": 8,
          "maxLength": 2048
        },
        "acquiredAt": {
          "$ref": "#/$defs/Time"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "licenseName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "attributionText": {
          "type": "string",
          "minLength": 1,
          "maxLength": 3000
        },
        "usageScope": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "licenseVersion": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "provider",
        "assetId",
        "sourceUrl",
        "creatorName",
        "creatorUrl",
        "licenseUrl",
        "acquiredAt"
      ],
      "additionalProperties": false
    },
    "MediaReferenceContent": {
      "type": "object",
      "properties": {
        "format": {
          "const": "media_reference",
          "type": "string"
        },
        "blobId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "format",
        "blobId"
      ],
      "additionalProperties": false
    },
    "NewsNowSettings": {
      "type": "object",
      "properties": {
        "serviceId": {
          "const": "newsnow",
          "type": "string"
        },
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "endpoint": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 8,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "sourceIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]{1,80}$"
          },
          "minItems": 0,
          "maxItems": 5,
          "uniqueItems": true
        },
        "topics": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "minItems": 0,
          "maxItems": 10,
          "uniqueItems": true
        }
      },
      "required": [
        "serviceId",
        "revision",
        "enabled",
        "endpoint",
        "sourceIds",
        "topics"
      ],
      "additionalProperties": false
    },
    "SaveNewsNowSettings": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "endpoint": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 8,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "sourceIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]{1,80}$"
          },
          "minItems": 0,
          "maxItems": 5,
          "uniqueItems": true
        },
        "topics": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "minItems": 0,
          "maxItems": 10,
          "uniqueItems": true
        }
      },
      "required": [
        "commandId",
        "expectedRevision",
        "enabled",
        "endpoint",
        "sourceIds",
        "topics"
      ],
      "additionalProperties": false
    },
    "PexelsSettings": {
      "type": "object",
      "properties": {
        "serviceId": {
          "const": "pexels",
          "type": "string"
        },
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "credentialConfigured": {
          "type": "boolean"
        },
        "endpoint": {
          "const": "https://api.pexels.com/v1",
          "type": "string"
        },
        "writeUnavailableReason": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            },
            {
              "type": "null"
            }
          ]
        },
        "apiKey": {
          "type": [
            "string",
            "null"
          ],
          "description": "完整 Key 仅设置 GET 返回，供本机个人页面查看；保存回执省略，不进入 Bootstrap、事件或 Agent 上下文。"
        }
      },
      "required": [
        "serviceId",
        "revision",
        "enabled",
        "credentialConfigured",
        "endpoint",
        "writeUnavailableReason"
      ],
      "additionalProperties": false
    },
    "SavePexelsSettings": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "apiKey": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096,
              "writeOnly": true
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "commandId",
        "expectedRevision",
        "enabled",
        "apiKey"
      ],
      "additionalProperties": false
    },
    "SaveFreeServiceSettings": {
      "oneOf": [
        {
          "$ref": "#/$defs/SavePexelsSettings"
        },
        {
          "$ref": "#/$defs/SaveKeylessServiceSettings"
        },
        {
          "$ref": "#/$defs/SaveNewsNowSettings"
        }
      ]
    },
    "SaveFreeServiceSettingsReceipt": {
      "type": "object",
      "properties": {
        "settings": {
          "oneOf": [
            {
              "$ref": "#/$defs/PexelsSettings"
            },
            {
              "$ref": "#/$defs/KeyedMaterialSettings"
            },
            {
              "$ref": "#/$defs/KeylessMaterialSettings"
            },
            {
              "$ref": "#/$defs/NewsNowSettings"
            }
          ]
        },
        "replayed": {
          "type": "boolean"
        }
      },
      "required": [
        "settings",
        "replayed"
      ],
      "additionalProperties": false
    },
    "Time": {
      "type": "string",
      "format": "date-time"
    },
    "Money": {
      "type": "object",
      "properties": {
        "currency": {
          "const": "CNY",
          "type": "string"
        },
        "amountMinor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "currency",
        "amountMinor"
      ],
      "additionalProperties": false
    },
    "RevisionRef": {
      "type": "object",
      "properties": {
        "artifactId": {
          "$ref": "#/$defs/Id"
        },
        "revisionId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "artifactId",
        "revisionId"
      ],
      "additionalProperties": false
    },
    "ProposalRef": {
      "type": "object",
      "properties": {
        "proposalId": {
          "$ref": "#/$defs/Id"
        },
        "digest": {
          "$ref": "#/$defs/Digest"
        }
      },
      "required": [
        "proposalId",
        "digest"
      ],
      "additionalProperties": false
    },
    "Target": {
      "type": "object",
      "properties": {
        "artifactId": {
          "$ref": "#/$defs/Id"
        },
        "revisionId": {
          "$ref": "#/$defs/Id"
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "segment": {
          "type": "object",
          "properties": {
            "runId": {
              "$ref": "#/$defs/Id"
            },
            "segmentId": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "runId",
            "segmentId"
          ],
          "additionalProperties": false,
          "description": "用户正在讨论的那次运行片段；artifact/revision 仍指向当前要修改的方案草稿。work、run 与段对应性在入口核对一次。"
        }
      },
      "required": [
        "artifactId",
        "revisionId",
        "workId"
      ],
      "additionalProperties": false
    },
    "ErrorCode": {
      "type": "string",
      "enum": [
        "INVALID_INPUT",
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "NOT_FOUND",
        "STALE_REVISION",
        "IDEMPOTENCY_CONFLICT",
        "DELIVERY_CLOSED",
        "RUN_BUSY",
        "AUTHORIZATION_REQUIRED",
        "PROPOSAL_STALE",
        "BUDGET_INSUFFICIENT",
        "CAPABILITY_UNAVAILABLE",
        "QUEUE_FULL",
        "CURSOR_EXPIRED",
        "REQUEST_NOT_RUNNING",
        "TEMPORARILY_UNAVAILABLE",
        "TARGET_SCOPE_MISMATCH"
      ]
    },
    "Error": {
      "type": "object",
      "properties": {
        "code": {
          "$ref": "#/$defs/ErrorCode"
        },
        "message": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1200
        },
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "retryAction": {
          "type": "string",
          "enum": [
            "none",
            "reauthenticate",
            "reload",
            "same_command",
            "wait"
          ]
        },
        "currentRevisionId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "code",
        "message",
        "requestId",
        "retryAction",
        "currentRevisionId"
      ],
      "additionalProperties": false
    },
    "Conversation": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "updatedAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "id",
        "title",
        "revision",
        "updatedAt"
      ],
      "additionalProperties": false
    },
    "CreateConversation": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "commandId",
        "title"
      ],
      "additionalProperties": false
    },
    "RenameConversation": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "commandId",
        "title",
        "expectedRevision"
      ],
      "additionalProperties": false
    },
    "MessageInput": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32000
        },
        "target": {
          "anyOf": [
            {
              "$ref": "#/$defs/Target"
            },
            {
              "type": "null"
            }
          ]
        },
        "skillId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "proposalRef": {
          "anyOf": [
            {
              "$ref": "#/$defs/ProposalRef"
            },
            {
              "type": "null"
            }
          ]
        },
        "mode": {
          "type": "string",
          "enum": [
            "new",
            "steer"
          ]
        },
        "steerRequestId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "stageConfirmation": {
          "anyOf": [
            {
              "$ref": "#/$defs/StageConfirmation"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "commandId",
        "text",
        "target",
        "skillId",
        "proposalRef",
        "mode",
        "steerRequestId"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "mode": {
                "const": "steer"
              }
            }
          },
          "then": {
            "properties": {
              "steerRequestId": {
                "$ref": "#/$defs/Id"
              },
              "proposalRef": {
                "type": "null"
              }
            }
          },
          "else": {
            "properties": {
              "steerRequestId": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "proposalRef": {
                "type": "object"
              }
            }
          },
          "then": {
            "properties": {
              "target": {
                "type": "null"
              },
              "skillId": {
                "type": "null"
              },
              "mode": {
                "const": "new"
              },
              "steerRequestId": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "stageConfirmation": {
                "type": "object"
              }
            },
            "required": [
              "stageConfirmation"
            ]
          },
          "then": {
            "properties": {
              "mode": {
                "const": "new"
              },
              "steerRequestId": {
                "type": "null"
              },
              "proposalRef": {
                "type": "null"
              },
              "target": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "stageConfirmation": {
                "type": "object",
                "properties": {
                  "action": {
                    "not": {
                      "const": "approve_content_continue"
                    }
                  }
                },
                "required": [
                  "action"
                ]
              }
            },
            "required": [
              "stageConfirmation"
            ]
          },
          "then": {
            "properties": {
              "skillId": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "stageConfirmation": {
                "type": "object",
                "properties": {
                  "action": {
                    "enum": [
                      "approve_plan",
                      "finalize_video"
                    ]
                  }
                },
                "required": [
                  "action"
                ]
              }
            },
            "required": [
              "stageConfirmation"
            ]
          },
          "then": {
            "properties": {
              "stageConfirmation": {
                "type": "object",
                "properties": {
                  "subject": {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "artifact_revision"
                      }
                    },
                    "required": [
                      "kind"
                    ]
                  }
                },
                "required": [
                  "subject"
                ]
              }
            }
          }
        }
      ]
    },
    "Message": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "requestId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "user",
            "assistant",
            "system_notice"
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 64000
        },
        "state": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "completed",
            "stopped",
            "failed"
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "target": {
          "anyOf": [
            {
              "$ref": "#/$defs/Target"
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        },
        "references": {
          "$ref": "#/$defs/MessageReferences"
        },
        "kind": {
          "type": "string",
          "enum": [
            "chat",
            "feedback",
            "notice"
          ]
        },
        "feedback": {
          "anyOf": [
            {
              "$ref": "#/$defs/FeedbackNote"
            },
            {
              "type": "null"
            }
          ]
        },
        "createdSequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991,
          "description": "服务端分配的会话内不可变创建顺序；只用于显示排序，不是 SSE 游标。"
        }
      },
      "required": [
        "id",
        "requestId",
        "role",
        "text",
        "state",
        "revision",
        "target",
        "createdAt",
        "references",
        "kind",
        "feedback",
        "createdSequence"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "feedback"
              }
            }
          },
          "then": {
            "properties": {
              "feedback": {
                "$ref": "#/$defs/FeedbackNote"
              },
              "role": {
                "const": "user"
              },
              "requestId": {
                "type": "null"
              },
              "state": {
                "const": "completed"
              }
            }
          },
          "else": {
            "if": {
              "properties": {
                "kind": {
                  "const": "chat"
                },
                "role": {
                  "const": "user"
                }
              }
            },
            "then": {},
            "else": {
              "properties": {
                "feedback": {
                  "type": "null"
                }
              }
            }
          }
        }
      ]
    },
    "RequestReceipt": {
      "type": "object",
      "properties": {
        "receiptId": {
          "$ref": "#/$defs/Id"
        },
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "messageId": {
          "$ref": "#/$defs/Id"
        },
        "state": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "completed",
            "stopped",
            "failed"
          ]
        },
        "replayed": {
          "type": "boolean"
        },
        "runId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "receiptId",
        "requestId",
        "messageId",
        "state",
        "replayed",
        "runId"
      ],
      "additionalProperties": false
    },
    "StopRequest": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "commandId"
      ],
      "additionalProperties": false
    },
    "ArtifactHead": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "kind": {
          "type": "string",
          "enum": [
            "prompt",
            "script",
            "analysis",
            "video",
            "image",
            "audio"
          ]
        },
        "revisionId": {
          "$ref": "#/$defs/Id"
        },
        "revisionNumber": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "updatedAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "id",
        "title",
        "kind",
        "revisionId",
        "revisionNumber",
        "workId",
        "updatedAt"
      ],
      "additionalProperties": false
    },
    "MarkdownSection": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64000,
          "description": "该段正文；段落级长度受完整正文总量约束，不是每段各 64000。"
        },
        "sourceSectionIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "minItems": 1,
          "maxItems": 24,
          "description": "仅 plan 稿段落使用：指向它准确 source 内容修订的段落 id；内容稿段落不得携带。无对应内容段落的补画面段可省略，不捏造引用。"
        }
      },
      "required": [
        "id",
        "title",
        "text"
      ],
      "additionalProperties": false
    },
    "MarkdownContent": {
      "type": "object",
      "properties": {
        "format": {
          "const": "markdown",
          "type": "string"
        },
        "text": {
          "type": "string",
          "minLength": 0,
          "maxLength": 64000,
          "description": "无 sections 时为完整正文（非空）；有 sections 时只写全局说明，可为空。完整正文＝全局说明＋有序段落＋旁白，总量 64000 字符在交付边界核对。"
        },
        "narrationText": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000,
          "description": "可选的整条逐字旁白。带独立配音的视频方案用此字段唯一保存朗读原句；正文和镜头段只描述声音安排。制作实际朗读输入必须逐字相同，换词须交付新方案，不能让旧方案绑定新台词。普通文稿、Prompt 和独立配音保持原语义。"
        },
        "sections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MarkdownSection"
          },
          "minItems": 1,
          "maxItems": 24,
          "description": "可选有序段落；段 id 在同一稿件后续修订保留、重排只改顺序。段 id 唯一性及 sourceSectionIds 对应性在交付边界核对一次。"
        }
      },
      "required": [
        "format",
        "text"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "required": [
              "sections"
            ],
            "properties": {
              "sections": {}
            }
          },
          "then": {
            "properties": {
              "text": {
                "type": "string",
                "minLength": 0
              }
            }
          },
          "else": {
            "properties": {
              "text": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        }
      ]
    },
    "MediaContent": {
      "type": "object",
      "properties": {
        "format": {
          "const": "media",
          "type": "string"
        },
        "blobId": {
          "$ref": "#/$defs/Id"
        },
        "mimeType": {
          "type": "string",
          "enum": [
            "video/mp4",
            "video/webm",
            "image/png",
            "image/jpeg",
            "audio/mpeg",
            "audio/wav"
          ]
        },
        "durationMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 86400000
            },
            {
              "type": "null"
            }
          ]
        },
        "sources": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MediaProvenance"
          },
          "minItems": 0,
          "maxItems": 64,
          "description": "按(provider,assetId)去重的素材来源；旧记录缺省视为空。"
        }
      },
      "required": [
        "format",
        "blobId",
        "mimeType",
        "durationMs"
      ],
      "additionalProperties": false
    },
    "ArtifactRevision": {
      "type": "object",
      "properties": {
        "artifactId": {
          "$ref": "#/$defs/Id"
        },
        "revisionId": {
          "$ref": "#/$defs/Id"
        },
        "revisionNumber": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "baseRevisionId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "requestId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "digest": {
          "$ref": "#/$defs/Digest"
        },
        "content": {
          "oneOf": [
            {
              "$ref": "#/$defs/MarkdownContent"
            },
            {
              "$ref": "#/$defs/MediaContent"
            }
          ]
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "artifactId",
        "revisionId",
        "revisionNumber",
        "baseRevisionId",
        "requestId",
        "runId",
        "digest",
        "content",
        "createdAt"
      ],
      "additionalProperties": false
    },
    "FeedbackInput": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "target": {
          "$ref": "#/$defs/Target"
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 8000
        }
      },
      "required": [
        "commandId",
        "target",
        "text"
      ],
      "additionalProperties": false
    },
    "FeedbackReceipt": {
      "type": "object",
      "properties": {
        "target": {
          "anyOf": [
            {
              "$ref": "#/$defs/Target"
            },
            {
              "type": "null"
            }
          ]
        },
        "applied": {
          "const": false,
          "type": "boolean"
        },
        "disposition": {
          "type": "string",
          "enum": [
            "noted",
            "next_version"
          ]
        },
        "replayed": {
          "type": "boolean"
        },
        "messageId": {
          "$ref": "#/$defs/Id"
        },
        "messageRevision": {
          "type": "integer",
          "minimum": 1
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "contentSource": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "target",
        "workId",
        "contentSource",
        "applied",
        "disposition",
        "replayed",
        "messageId",
        "messageRevision"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "target": {
                "type": "null"
              }
            }
          },
          "then": {
            "properties": {
              "workId": {
                "not": {
                  "type": "null"
                }
              },
              "contentSource": {
                "not": {
                  "type": "null"
                }
              }
            },
            "required": [
              "workId",
              "contentSource"
            ]
          }
        }
      ]
    },
    "ModelBinding": {
      "type": "object",
      "properties": {
        "providerId": {
          "$ref": "#/$defs/Id"
        },
        "modelId": {
          "$ref": "#/$defs/ProviderModelId"
        },
        "connectionId": {
          "$ref": "#/$defs/Id"
        },
        "configurationRevisionId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "providerId",
        "modelId",
        "connectionId",
        "configurationRevisionId"
      ],
      "additionalProperties": false
    },
    "ModelEntry": {
      "type": "object",
      "properties": {
        "binding": {
          "$ref": "#/$defs/ModelBinding"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "kind": {
          "type": "string",
          "enum": [
            "text",
            "image",
            "video",
            "speech"
          ]
        },
        "features": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "minItems": 0,
          "maxItems": 12
        },
        "availability": {
          "type": "string",
          "enum": [
            "configured",
            "unavailable",
            "unverified"
          ]
        },
        "verificationNote": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "isDefault": {
          "type": "boolean"
        }
      },
      "required": [
        "binding",
        "name",
        "kind",
        "features",
        "availability",
        "verificationNote",
        "isDefault"
      ],
      "additionalProperties": false
    },
    "SkillSummary": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "description": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        }
      },
      "required": [
        "id",
        "name",
        "description"
      ],
      "additionalProperties": false
    },
    "SkillPackage": {
      "type": "object",
      "description": "当前已配置来源的 Skill 发现结果；内置来源只读，诊断不含凭据或安装日志。id 是服务端从当前原生来源生成的稳定不透明标识；卸载时从当前列表映射来源。",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048,
          "description": "Pi 原生 npm、Git 或服务端本机包目录来源；不含内嵌凭据。"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "origin": {
          "type": "string",
          "enum": [
            "builtin",
            "installed"
          ]
        },
        "skillIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "minItems": 0,
          "maxItems": 200,
          "uniqueItems": true
        },
        "status": {
          "type": "string",
          "enum": [
            "ready",
            "no_skills",
            "invalid"
          ],
          "description": "ready 表示实际发现可用 Skill；零个 Skill 为 no_skills，来源或原生解析不可用为 invalid，不能宣称可用。"
        },
        "diagnostics": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1200
          },
          "minItems": 0,
          "maxItems": 200
        }
      },
      "required": [
        "id",
        "source",
        "name",
        "origin",
        "skillIds",
        "status",
        "diagnostics"
      ],
      "additionalProperties": false
    },
    "SkillPackageMutation": {
      "type": "object",
      "description": "当前进程中的包管理操作；不构成持久命令回执或依赖命令执行证明。",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "install",
            "remove"
          ]
        },
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": [
        "action",
        "source"
      ],
      "additionalProperties": false
    },
    "SkillPackagesView": {
      "type": "object",
      "description": "应用当前已配置包、实际发现的 Skill 与解析诊断；只读刷新不会安装或升级包。skills 与 Bootstrap 使用同一当前目录。",
      "properties": {
        "packages": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SkillPackage"
          },
          "minItems": 0,
          "maxItems": 200
        },
        "skills": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SkillSummary"
          },
          "minItems": 0,
          "maxItems": 200
        },
        "mutation": {
          "anyOf": [
            {
              "$ref": "#/$defs/SkillPackageMutation"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "packages",
        "skills",
        "mutation"
      ],
      "additionalProperties": false
    },
    "InstallSkillPackage": {
      "type": "object",
      "properties": {
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048,
          "description": "Pi 原生包来源；本机目录是服务端目录。服务端拒绝 URL 内嵌凭据，SDK 负责解析来源与 manifest。"
        }
      },
      "required": [
        "source"
      ],
      "additionalProperties": false
    },
    "RemoveSkillPackage": {
      "type": "object",
      "description": "packageId 是当前 SkillPackagesView 中已安装包的标识；不能提交任意文件路径，内置包不可卸载。",
      "properties": {
        "packageId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "packageId"
      ],
      "additionalProperties": false
    },
    "Bootstrap": {
      "type": "object",
      "properties": {
        "ownerId": {
          "$ref": "#/$defs/Id"
        },
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "models": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ModelEntry"
          },
          "minItems": 0,
          "maxItems": 200
        },
        "skills": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SkillSummary"
          },
          "minItems": 0,
          "maxItems": 200
        }
      },
      "required": [
        "ownerId",
        "displayName",
        "models",
        "skills"
      ],
      "additionalProperties": false
    },
    "InputRef": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "text",
              "type": "string"
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64000,
              "description": "本次制作使用的完整文字，随提案与执行快照冻结；不创建作品或模板。"
            }
          },
          "required": [
            "kind",
            "text"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "artifact_revision",
              "type": "string"
            },
            "artifactId": {
              "$ref": "#/$defs/Id"
            },
            "revisionId": {
              "$ref": "#/$defs/Id"
            },
            "digest": {
              "$ref": "#/$defs/Digest"
            }
          },
          "required": [
            "kind",
            "artifactId",
            "revisionId",
            "digest"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "blob",
              "type": "string"
            },
            "blobId": {
              "$ref": "#/$defs/Id"
            },
            "digest": {
              "$ref": "#/$defs/Digest"
            }
          },
          "required": [
            "kind",
            "blobId",
            "digest"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "operation_output",
              "type": "string"
            },
            "producerOperationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "kind",
            "producerOperationId",
            "outputSlot"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ToolSearchMaterials": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "kind": {
          "type": "string",
          "enum": [
            "image",
            "video",
            "audio"
          ]
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "provider": {
          "anyOf": [
            {
              "$ref": "#/$defs/MaterialProvider"
            },
            {
              "type": "null"
            }
          ],
          "description": "指定已启用来源；图片/视频省略按Pexels，音乐省略选首个已启用曲源。可按用户目标指定曲源。指定不支持的类型不会暗换来源。"
        }
      },
      "required": [
        "query",
        "kind",
        "limit"
      ],
      "additionalProperties": false,
      "description": "搜索已启用来源的image/video/audio素材并保存原批次顺序；跨轮用read_material_batch读原批次，import_material采用后才可交付blob。音频声乐标注来自供应商，未知不猜；音乐搜索不自动开始视频事项。"
    },
    "ToolReadTrends": {
      "type": "object",
      "properties": {
        "sourceIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]{1,80}$"
          },
          "minItems": 1,
          "maxItems": 5,
          "uniqueItems": true
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "musicChart": {
          "type": "string",
          "enum": [
            "douyin-music",
            "tiktok-sounds"
          ],
          "description": "选平台热歌榜时不带 NewsNow 的 sourceIds；查两个平台可分别调用。"
        }
      },
      "required": [
        "limit"
      ],
      "additionalProperties": false,
      "description": "读取已启用的平台热歌榜或已配置的 NewsNow 资讯。limit 为每个来源的条目上限。音乐榜只提供发现链接，不授予音频采用权。"
    },
    "ToolImportMaterial": {
      "type": "object",
      "properties": {
        "candidateId": {
          "$ref": "#/$defs/Id"
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "usage": {
          "type": "string",
          "enum": [
            "personal_social_ugc",
            "other"
          ],
          "description": "FreeToUse免费采用须明确为个人社交平台自制内容personal_social_ugc；商业/品牌/赞助等other不适用。用途不明先问一次；其他素材可省略。"
        }
      },
      "required": [
        "candidateId"
      ],
      "additionalProperties": false,
      "description": "采用本会话原批次的准确候选为私有媒体blob并登记来源；重复采用复用原文件与许可事实。不构成方案认可、制作授权或定稿。FreeToUse免费音乐须明确个人社交平台UGC用途。"
    },
    "TrendItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "url": {
          "type": "string",
          "minLength": 8,
          "maxLength": 2048
        },
        "publishedAt": {
          "anyOf": [
            {
              "$ref": "#/$defs/Time"
            },
            {
              "type": "null"
            }
          ]
        },
        "rank": {
          "type": "integer",
          "minimum": 1
        },
        "artist": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        }
      },
      "required": [
        "id",
        "title",
        "url",
        "publishedAt",
        "rank"
      ],
      "additionalProperties": false
    },
    "TrendSnapshot": {
      "type": "object",
      "properties": {
        "sourceId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,80}$"
        },
        "status": {
          "type": "string",
          "enum": [
            "success",
            "cache",
            "unavailable"
          ]
        },
        "sourceUpdatedAt": {
          "anyOf": [
            {
              "$ref": "#/$defs/Time"
            },
            {
              "type": "null"
            }
          ]
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TrendItem"
          },
          "minItems": 0,
          "maxItems": 20
        },
        "error": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            },
            {
              "type": "null"
            }
          ]
        },
        "chartUrl": {
          "type": "string",
          "format": "uri"
        },
        "linkKind": {
          "type": "string",
          "enum": [
            "platform_search",
            "platform_sound"
          ],
          "description": "曲名搜索页或具体原声页。"
        }
      },
      "required": [
        "sourceId",
        "status",
        "sourceUpdatedAt",
        "items",
        "error"
      ],
      "additionalProperties": false
    },
    "TrendReadResult": {
      "type": "object",
      "properties": {
        "sources": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TrendSnapshot"
          },
          "minItems": 1,
          "maxItems": 5
        },
        "retrievedAt": {
          "$ref": "#/$defs/Time"
        },
        "topics": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "minItems": 0,
          "maxItems": 10
        }
      },
      "required": [
        "sources",
        "retrievedAt",
        "topics"
      ],
      "additionalProperties": false
    },
    "VideoParameters": {
      "type": "object",
      "properties": {
        "durationSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 600
        },
        "aspectRatio": {
          "type": "string",
          "enum": [
            "16:9",
            "9:16",
            "1:1"
          ]
        },
        "resolution": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "audioMode": {
          "type": "string",
          "enum": [
            "none",
            "native"
          ]
        }
      },
      "required": [
        "durationSeconds",
        "aspectRatio",
        "resolution",
        "audioMode"
      ],
      "additionalProperties": false
    },
    "ImageParameters": {
      "type": "object",
      "properties": {
        "aspectRatio": {
          "type": "string",
          "enum": [
            "16:9",
            "9:16",
            "1:1"
          ]
        },
        "resolution": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      },
      "required": [
        "aspectRatio",
        "resolution"
      ],
      "additionalProperties": false
    },
    "SpeechParameters": {
      "type": "object",
      "properties": {
        "voiceId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "供应商声线标识，原样传递不做改写；可含空格与括号（如 MiniMax 系统声线 Chinese (Mandarin)_News_Anchor），不套内部 Id 正则。具体可执行声线集合由当前 speech profile 判定。"
        },
        "format": {
          "type": "string",
          "enum": [
            "mp3",
            "wav"
          ]
        }
      },
      "required": [
        "voiceId",
        "format"
      ],
      "additionalProperties": false
    },
    "RenderParameters": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "format": {
              "const": "mp4",
              "type": "string"
            },
            "width": {
              "type": "integer",
              "minimum": 1,
              "maximum": 8192
            },
            "height": {
              "type": "integer",
              "minimum": 1,
              "maximum": 8192
            },
            "fps": {
              "type": "integer",
              "minimum": 1,
              "maximum": 120
            },
            "assembly": {
              "const": "ordered_concat",
              "type": "string"
            },
            "audioMode": {
              "type": "string",
              "enum": [
                "none",
                "preserve"
              ]
            },
            "segmentIds": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/Id"
              },
              "minItems": 1,
              "maxItems": 24,
              "uniqueItems": true,
              "description": "可选：与 inputs 的视觉顺序一一对应，每项指向本方案一个 section id；长度一致性与引用对应在准备提案边界核对一次后冻结。"
            }
          },
          "required": [
            "format",
            "width",
            "height",
            "fps",
            "assembly"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "format": {
              "const": "mp4",
              "type": "string"
            },
            "width": {
              "const": 1280,
              "type": "integer"
            },
            "height": {
              "const": 720,
              "type": "integer"
            },
            "fps": {
              "const": 24,
              "type": "integer"
            },
            "assembly": {
              "const": "narrated_concat",
              "type": "string"
            },
            "videoInputSlots": {
              "type": "array",
              "minItems": 1,
              "maxItems": 23,
              "uniqueItems": true,
              "items": {
                "type": "integer",
                "minimum": 0,
                "maximum": 23
              }
            },
            "narrationInputSlot": {
              "type": "integer",
              "minimum": 0,
              "maximum": 23
            },
            "durationPolicy": {
              "const": "preserve_all",
              "type": "string"
            },
            "segmentIds": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/Id"
              },
              "minItems": 1,
              "maxItems": 24,
              "uniqueItems": true,
              "description": "可选：与 videoInputSlots 顺序一一对应，每项指向本方案一个 section id；长度一致性与引用对应在准备提案边界核对一次后冻结。"
            }
          },
          "required": [
            "format",
            "width",
            "height",
            "fps",
            "assembly",
            "videoInputSlots",
            "narrationInputSlot",
            "durationPolicy"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "format": {
              "const": "mp4",
              "type": "string"
            },
            "width": {
              "const": 1280,
              "type": "integer"
            },
            "height": {
              "const": 720,
              "type": "integer"
            },
            "fps": {
              "const": 24,
              "type": "integer"
            },
            "assembly": {
              "const": "timed_narrated_concat",
              "type": "string"
            },
            "segments": {
              "type": "array",
              "minItems": 1,
              "maxItems": 24,
              "items": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "video",
                        "type": "string"
                      },
                      "inputSlot": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 23
                      },
                      "startMs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 120000
                      },
                      "durationMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 120000
                      }
                    },
                    "required": [
                      "kind",
                      "inputSlot",
                      "startMs",
                      "durationMs"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "image",
                        "type": "string"
                      },
                      "inputSlot": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 23
                      },
                      "durationMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 120000
                      }
                    },
                    "required": [
                      "kind",
                      "inputSlot",
                      "durationMs"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "narrationInputSlot": {
              "type": "integer",
              "minimum": 0,
              "maximum": 23
            },
            "segmentIds": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/Id"
              },
              "minItems": 1,
              "maxItems": 24,
              "uniqueItems": true,
              "description": "可选：与 segments 顺序一一对应，每项指向本方案一个 section id；长度一致性与引用对应在准备提案边界核对一次后冻结。"
            }
          },
          "required": [
            "format",
            "width",
            "height",
            "fps",
            "assembly",
            "segments",
            "narrationInputSlot"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "format": {
              "type": "string",
              "const": "mp4"
            },
            "width": {
              "type": "integer",
              "const": 1280
            },
            "height": {
              "type": "integer",
              "const": 720
            },
            "fps": {
              "type": "integer",
              "const": 24
            },
            "assembly": {
              "type": "string",
              "const": "mixed_concat"
            },
            "segments": {
              "type": "array",
              "minItems": 1,
              "maxItems": 24,
              "items": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "video",
                        "type": "string"
                      },
                      "inputSlot": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 23
                      },
                      "startMs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 120000
                      },
                      "durationMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 120000
                      },
                      "originalGain": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      }
                    },
                    "required": [
                      "kind",
                      "inputSlot",
                      "startMs",
                      "durationMs"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "image",
                        "type": "string"
                      },
                      "inputSlot": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 23
                      },
                      "durationMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 120000
                      }
                    },
                    "required": [
                      "kind",
                      "inputSlot",
                      "durationMs"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "segmentIds": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/Id"
              },
              "minItems": 1,
              "maxItems": 24,
              "uniqueItems": true,
              "description": "可选：与 segments 顺序一一对应，每项指向本方案一个 section id；长度一致性与引用对应在准备提案边界核对一次后冻结。"
            },
            "music": {
              "type": "object",
              "properties": {
                "inputSlot": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 23
                },
                "candidateId": {
                  "$ref": "#/$defs/Id"
                },
                "sourceStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 86400000
                },
                "sourceDurationMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 86400000
                },
                "timelineStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "playDurationMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 120000
                },
                "repeat": {
                  "type": "boolean"
                },
                "gain": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "fadeInMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "fadeOutMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "duckUnderNarration": {
                  "type": "boolean"
                }
              },
              "required": [
                "inputSlot",
                "candidateId",
                "sourceStartMs",
                "sourceDurationMs",
                "timelineStartMs",
                "playDurationMs",
                "repeat",
                "gain",
                "fadeInMs",
                "fadeOutMs",
                "duckUnderNarration"
              ],
              "additionalProperties": false
            },
            "narration": {
              "type": "object",
              "properties": {
                "inputSlot": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 23
                },
                "timelineStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "gain": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                }
              },
              "required": [
                "inputSlot",
                "timelineStartMs",
                "gain"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "format",
            "width",
            "height",
            "fps",
            "assembly",
            "segments",
            "segmentIds"
          ],
          "additionalProperties": false,
          "description": "三路声音按冻结参数混音：视觉时长≤120s、所有输入合计≤24；原声逐段0–1，音乐最多一路且绑定本会话已采用候选，配音完整使用。prepare核对槽位/范围/fade/来源并展开缺省原声增益；没有有声独立配音时duck冻结false。48kHz立体声AAC，不延长画面或截配音。"
        }
      ]
    },
    "OperationSpec": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "quotePerAttempt": {
              "$ref": "#/$defs/Money"
            },
            "priceKind": {
              "type": "string",
              "enum": [
                "bounded",
                "estimate"
              ]
            },
            "kind": {
              "const": "video",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/VideoParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "quotePerAttempt",
            "priceKind",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "quotePerAttempt": {
              "$ref": "#/$defs/Money"
            },
            "priceKind": {
              "type": "string",
              "enum": [
                "bounded",
                "estimate"
              ]
            },
            "kind": {
              "const": "image",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/ImageParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "quotePerAttempt",
            "priceKind",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "quotePerAttempt": {
              "$ref": "#/$defs/Money"
            },
            "priceKind": {
              "type": "string",
              "enum": [
                "bounded",
                "estimate"
              ]
            },
            "kind": {
              "const": "speech",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/SpeechParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "quotePerAttempt",
            "priceKind",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "const": 1
            },
            "quotePerAttempt": {
              "allOf": [
                {
                  "$ref": "#/$defs/Money"
                },
                {
                  "type": "object",
                  "properties": {
                    "amountMinor": {
                      "const": 0
                    }
                  },
                  "required": [
                    "amountMinor"
                  ]
                }
              ]
            },
            "priceKind": {
              "type": "string",
              "const": "bounded"
            },
            "kind": {
              "const": "render",
              "type": "string"
            },
            "model": {
              "type": "null"
            },
            "parameters": {
              "$ref": "#/$defs/RenderParameters"
            },
            "musicSource": {
              "$ref": "#/$defs/MediaProvenance",
              "description": "只读：prepare按music.candidateId与音频blob准确绑定首次采用事实，在digest前冻结；工具及OperationRequest不接受提交。"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "quotePerAttempt",
            "priceKind",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ProductionSpec": {
      "type": "object",
      "properties": {
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "inputRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 0,
          "maxItems": 8
        },
        "operations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/OperationSpec"
          },
          "minItems": 1,
          "maxItems": 24
        },
        "finalOutput": {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "operationId",
            "outputSlot"
          ],
          "additionalProperties": false
        },
        "maxSpend": {
          "$ref": "#/$defs/Money"
        }
      },
      "required": [
        "workId",
        "title",
        "inputRevisions",
        "operations",
        "finalOutput",
        "maxSpend"
      ],
      "additionalProperties": false
    },
    "PrepareProposal": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "spec": {
          "$ref": "#/$defs/ProductionIntent"
        },
        "planSource": {
          "$ref": "#/$defs/RevisionRef",
          "description": "准备已交付方案的制作时，引用该作品当前方案的准确修订；无需复制方案或重新认可。不作为媒体输入。"
        },
        "replacesProposal": {
          "$ref": "#/$defs/ProposalRef",
          "description": "仅在用户明确替换某份报价时提供其准确 ID 和 digest。服务端核对同一会话、事项、方案与制作范围后撤销指定旧 ready 报价；普通备选和其他事项不受影响。新额度不足时旧报价仍已撤销，新提案不可执行。此意图不进入媒体执行 spec。"
        }
      },
      "required": [
        "commandId",
        "spec"
      ],
      "additionalProperties": false
    },
    "Proposal": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "conversationId": {
          "$ref": "#/$defs/Id"
        },
        "digest": {
          "$ref": "#/$defs/Digest"
        },
        "spec": {
          "$ref": "#/$defs/ProductionSpec"
        },
        "state": {
          "type": "string",
          "enum": [
            "ready",
            "stale",
            "expired",
            "accepted"
          ]
        },
        "priceDisclosure": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1500
        },
        "expiresAt": {
          "$ref": "#/$defs/Time"
        },
        "acceptedRunId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "audioSummary": {
          "$ref": "#/$defs/AudioSummary"
        }
      },
      "required": [
        "id",
        "conversationId",
        "digest",
        "spec",
        "state",
        "priceDisclosure",
        "expiresAt",
        "acceptedRunId",
        "revision"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "state": {
                "const": "accepted"
              }
            }
          },
          "then": {
            "properties": {
              "acceptedRunId": {
                "$ref": "#/$defs/Id"
              }
            }
          },
          "else": {
            "properties": {
              "acceptedRunId": {
                "type": "null"
              }
            }
          }
        }
      ]
    },
    "AcceptProposal": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "proposalDigest": {
          "$ref": "#/$defs/Digest"
        }
      },
      "required": [
        "commandId",
        "proposalDigest"
      ],
      "additionalProperties": false
    },
    "RunState": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "unknown",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled"
      ],
      "description": "Run 表示本次编排（后续步骤与本地执行/等待）；Attempt 表示一次供应商或本地尝试，终态独立判定。cancelled 表示本次后续执行停止：本地执行/等待结束、已有收据处理完毕且剩余 unknown 无可用查询渠道时收敛；不保证远端尝试已取消，已提交 Attempt 保持 unknown、未知费用份额保留。"
    },
    "RunOperation": {
      "type": "object",
      "properties": {
        "operationId": {
          "$ref": "#/$defs/Id"
        },
        "kind": {
          "type": "string",
          "enum": [
            "video",
            "image",
            "speech",
            "render"
          ]
        },
        "state": {
          "type": "string",
          "enum": [
            "pending",
            "running",
            "succeeded",
            "failed",
            "cancelled"
          ]
        },
        "media": {
          "anyOf": [
            {
              "$ref": "#/$defs/MediaContent"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "operationId",
        "kind",
        "state",
        "media"
      ],
      "additionalProperties": false,
      "description": "冻结规格里一个操作步骤的只读执行事实；media 仅在输出落盘后给出，media 为 null 不代表失败。"
    },
    "Finance": {
      "type": "object",
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "reserved",
            "pending_reconciliation",
            "settled"
          ]
        },
        "currency": {
          "const": "CNY",
          "type": "string"
        },
        "reservedMinor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "pendingUnknownMinor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "settledMinor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "priceKind": {
          "type": "string",
          "enum": [
            "bounded",
            "estimate"
          ]
        }
      },
      "required": [
        "state",
        "currency",
        "reservedMinor",
        "pendingUnknownMinor",
        "settledMinor",
        "priceKind"
      ],
      "additionalProperties": false,
      "description": "三类金额互斥记账；未知从 reserved 转移，不能重复求和。实际超过预算仍完整记录。",
      "allOf": [
        {
          "if": {
            "properties": {
              "state": {
                "const": "settled"
              }
            }
          },
          "then": {
            "properties": {
              "reservedMinor": {
                "const": 0
              },
              "pendingUnknownMinor": {
                "const": 0
              }
            }
          }
        }
      ]
    },
    "RunSegment": {
      "type": "object",
      "properties": {
        "segmentId": {
          "$ref": "#/$defs/Id",
          "description": "对应本 run 冻结方案 section 的 id。"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "plan": {
          "$ref": "#/$defs/RevisionRef",
          "description": "本 run 冻结采用的方案修订。"
        },
        "content": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ],
          "description": "该段准确采用的内容来源；无对应内容段落的补画面段为 null。"
        },
        "sourceSectionIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "minItems": 0,
          "maxItems": 24,
          "description": "方案段落记录的内容段落引用，照冻结方案抄录。"
        },
        "media": {
          "anyOf": [
            {
              "$ref": "#/$defs/MediaContent"
            },
            {
              "type": "null"
            }
          ],
          "description": "该段画面输出；未就绪为 null。复用段仍为原 blob 与来源。"
        },
        "revision": {
          "anyOf": [
            {
              "$ref": "#/$defs/RevisionRef"
            },
            {
              "type": "null"
            }
          ],
          "description": "仅当冻结输入直接是 artifact_revision 时给出；operation_output 或只有 blob 事实时为 null，不反查任选一份修订。"
        },
        "state": {
          "type": "string",
          "enum": [
            "pending",
            "running",
            "succeeded",
            "failed",
            "cancelled"
          ],
          "description": "该段对应生产操作的真实执行状态。"
        },
        "startMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 120000
            },
            {
              "type": "null"
            }
          ],
          "description": "仅 timed 段给出：该段在源输入上的实际起始偏移；无裁切为 null。"
        },
        "durationMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 120000
            },
            {
              "type": "null"
            }
          ],
          "description": "仅 timed 段给出实际定长；无定长为 null。"
        }
      },
      "required": [
        "segmentId",
        "title",
        "plan",
        "content",
        "sourceSectionIds",
        "media",
        "revision",
        "state",
        "startMs",
        "durationMs"
      ],
      "additionalProperties": false,
      "description": "Run.segments 的只读投影：实际片段→冻结 render 输入槽→operation_output 或既有 blob→准确 plan section→内容 section。范围以 finalOutput render 的视觉输入为准；输入是另一项 render 结果时作为一个整体片段，不递归。"
    },
    "Run": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "conversationId": {
          "$ref": "#/$defs/Id"
        },
        "workId": {
          "$ref": "#/$defs/Id"
        },
        "snapshotId": {
          "$ref": "#/$defs/Id"
        },
        "proposalId": {
          "$ref": "#/$defs/Id"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "$ref": "#/$defs/RunState"
        },
        "finance": {
          "$ref": "#/$defs/Finance"
        },
        "inputRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 0,
          "maxItems": 8
        },
        "outputRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 0,
          "maxItems": 24
        },
        "operations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RunOperation"
          },
          "minItems": 0,
          "maxItems": 24,
          "description": "按冻结规格顺序排列的操作步骤及其真实状态；与 HTTP、SSE 投影和 read_run 共用同一事实。"
        },
        "segments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RunSegment"
          },
          "minItems": 0,
          "maxItems": 24,
          "description": "按 finalOutput render 视觉顺序排列的片段事实；render 未带 segmentIds 或无方案来源时为空数组。单项原生视频照常呈现整片。"
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        },
        "updatedAt": {
          "$ref": "#/$defs/Time"
        },
        "issue": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "code": {
                  "type": "string",
                  "enum": [
                    "PROVIDER_UNKNOWN",
                    "PROVIDER_FAILED",
                    "CANCEL_UNSUPPORTED",
                    "BUDGET_EXHAUSTED",
                    "INPUT_UNAVAILABLE"
                  ]
                },
                "message": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1200
                }
              },
              "required": [
                "code",
                "message"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "audioSummary": {
          "$ref": "#/$defs/AudioSummary"
        }
      },
      "required": [
        "id",
        "conversationId",
        "workId",
        "snapshotId",
        "proposalId",
        "revision",
        "state",
        "finance",
        "inputRevisions",
        "outputRevisions",
        "operations",
        "segments",
        "createdAt",
        "updatedAt",
        "issue",
        "title"
      ],
      "additionalProperties": false
    },
    "AdmissionReceipt": {
      "type": "object",
      "properties": {
        "receiptId": {
          "$ref": "#/$defs/Id"
        },
        "replayed": {
          "type": "boolean"
        },
        "run": {
          "$ref": "#/$defs/Run"
        }
      },
      "required": [
        "receiptId",
        "replayed",
        "run"
      ],
      "additionalProperties": false
    },
    "CancelRun": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "commandId",
        "expectedRevision"
      ],
      "additionalProperties": false
    },
    "CancelReceipt": {
      "type": "object",
      "properties": {
        "receiptId": {
          "$ref": "#/$defs/Id"
        },
        "replayed": {
          "type": "boolean"
        },
        "run": {
          "$ref": "#/$defs/Run"
        },
        "cancellation": {
          "type": "string",
          "enum": [
            "requested",
            "already_terminal"
          ]
        }
      },
      "required": [
        "receiptId",
        "replayed",
        "run",
        "cancellation"
      ],
      "additionalProperties": false
    },
    "ConversationPage": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Conversation"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "watermark": {
          "$ref": "#/$defs/Cursor"
        }
      },
      "required": [
        "items",
        "nextCursor",
        "watermark"
      ],
      "additionalProperties": false
    },
    "MessagePage": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Message"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "watermark": {
          "$ref": "#/$defs/Cursor"
        }
      },
      "required": [
        "items",
        "nextCursor",
        "watermark"
      ],
      "additionalProperties": false
    },
    "ArtifactPage": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ArtifactHead"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "watermark": {
          "$ref": "#/$defs/Cursor"
        }
      },
      "required": [
        "items",
        "nextCursor",
        "watermark"
      ],
      "additionalProperties": false
    },
    "RunPage": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Run"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "watermark": {
          "$ref": "#/$defs/Cursor"
        }
      },
      "required": [
        "items",
        "nextCursor",
        "watermark"
      ],
      "additionalProperties": false
    },
    "Snapshot": {
      "type": "object",
      "properties": {
        "conversation": {
          "$ref": "#/$defs/Conversation"
        },
        "eventCursor": {
          "$ref": "#/$defs/Cursor"
        },
        "messages": {
          "$ref": "#/$defs/MessagePage"
        },
        "artifacts": {
          "$ref": "#/$defs/ArtifactPage"
        },
        "runs": {
          "$ref": "#/$defs/RunPage"
        },
        "activeRequestId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "proposals": {
          "$ref": "#/$defs/ProposalPage"
        },
        "works": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Work"
          },
          "maxItems": 50
        },
        "materialBatches": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MaterialBatchIndexItem"
          },
          "maxItems": 100
        }
      },
      "required": [
        "conversation",
        "eventCursor",
        "messages",
        "artifacts",
        "runs",
        "activeRequestId",
        "proposals",
        "works",
        "materialBatches"
      ],
      "additionalProperties": false
    },
    "BusinessEvent": {
      "type": "object",
      "properties": {
        "eventId": {
          "$ref": "#/$defs/Id"
        },
        "cursor": {
          "$ref": "#/$defs/Cursor"
        },
        "conversationId": {
          "$ref": "#/$defs/Id"
        },
        "kind": {
          "type": "string",
          "enum": [
            "message.changed",
            "artifact.delivered",
            "proposal.changed",
            "run.changed",
            "conversation.changed",
            "work.changed",
            "material.changed"
          ]
        },
        "entityId": {
          "$ref": "#/$defs/Id"
        },
        "entityVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "notification": {
          "type": "string",
          "enum": [
            "quiet",
            "new_output"
          ]
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "eventId",
        "cursor",
        "conversationId",
        "kind",
        "entityId",
        "entityVersion",
        "notification",
        "createdAt"
      ],
      "additionalProperties": false
    },
    "TextDelta": {
      "type": "object",
      "properties": {
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "messageId": {
          "$ref": "#/$defs/Id"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "text": {
          "type": "string",
          "maxLength": 16000
        }
      },
      "required": [
        "requestId",
        "messageId",
        "sequence",
        "text"
      ],
      "additionalProperties": false
    },
    "ArtifactDraft": {
      "type": "object",
      "properties": {
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "messageId": {
          "$ref": "#/$defs/Id"
        },
        "draftId": {
          "$ref": "#/$defs/Id"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "state": {
          "type": "string",
          "enum": [
            "streaming",
            "cleared"
          ]
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ArtifactDraftItem"
          },
          "minItems": 0,
          "maxItems": 8
        }
      },
      "required": [
        "requestId",
        "messageId",
        "draftId",
        "sequence",
        "state",
        "items"
      ],
      "additionalProperties": false,
      "description": "暂态内容草稿快照：draftId 是流关联键，不是 artifactId/revisionId；cleared 只结束预览，不证明成功或失败。",
      "allOf": [
        {
          "if": {
            "properties": {
              "state": {
                "const": "cleared"
              }
            }
          },
          "then": {
            "properties": {
              "items": {
                "type": "array",
                "maxItems": 0
              }
            }
          }
        }
      ]
    },
    "ArtifactDraftItem": {
      "type": "object",
      "properties": {
        "itemIndex": {
          "type": "integer",
          "minimum": 0,
          "maximum": 7
        },
        "title": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 120
            },
            {
              "type": "null"
            }
          ]
        },
        "kind": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "prompt",
                "script",
                "analysis"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 64000
        }
      },
      "required": [
        "itemIndex",
        "title",
        "kind",
        "text"
      ],
      "additionalProperties": false,
      "description": "缺失字段用 null/空文本表示尚未出现；空文本不是正式空文档。"
    },
    "ResetRequired": {
      "type": "object",
      "properties": {
        "reason": {
          "const": "cursor_expired",
          "type": "string"
        }
      },
      "required": [
        "reason"
      ],
      "additionalProperties": false
    },
    "ContextStatus": {
      "type": "object",
      "properties": {
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "sequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "phase": {
          "type": "string",
          "enum": [
            "compacting",
            "compacted",
            "failed",
            "cancelled"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "threshold",
            "overflow"
          ]
        },
        "willRetry": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "requestId",
        "sequence",
        "phase",
        "reason",
        "willRetry"
      ],
      "additionalProperties": false,
      "description": "仅转发自动（threshold/overflow）上下文整理的暂态提示；不展示摘要内容，不是业务事件。",
      "allOf": [
        {
          "if": {
            "properties": {
              "phase": {
                "const": "compacting"
              }
            }
          },
          "then": {
            "properties": {
              "willRetry": {
                "type": "null"
              }
            }
          },
          "else": {
            "properties": {
              "willRetry": {
                "type": "boolean"
              }
            }
          }
        }
      ]
    },
    "DeliveryItem": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "create",
              "type": "string"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
            },
            "kind": {
              "type": "string",
              "enum": [
                "prompt",
                "script",
                "analysis"
              ]
            },
            "content": {
              "$ref": "#/$defs/MarkdownContent"
            }
          },
          "required": [
            "mode",
            "title",
            "kind",
            "content"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "create",
              "type": "string"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
            },
            "kind": {
              "type": "string",
              "enum": [
                "image",
                "video",
                "audio"
              ]
            },
            "content": {
              "$ref": "#/$defs/MediaReferenceContent"
            }
          },
          "required": [
            "mode",
            "title",
            "kind",
            "content"
          ],
          "additionalProperties": false,
          "description": "已采用素材可跨请求按同会话blob交付为媒体草稿；服务端核对类型和采用事实，不自动定稿。"
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "revise",
              "type": "string"
            },
            "artifactId": {
              "$ref": "#/$defs/Id"
            },
            "baseRevisionId": {
              "$ref": "#/$defs/Id"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
            },
            "kind": {
              "type": "string",
              "enum": [
                "prompt",
                "script",
                "analysis"
              ]
            },
            "content": {
              "$ref": "#/$defs/MarkdownContent"
            }
          },
          "required": [
            "mode",
            "artifactId",
            "baseRevisionId",
            "title",
            "kind",
            "content"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ToolDelivery": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/DeliveryItem"
          },
          "minItems": 1,
          "maxItems": 8
        },
        "stageDrafts": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/StageDraft"
          },
          "minItems": 1,
          "maxItems": 8
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false
    },
    "DeliveryReceipt": {
      "type": "object",
      "properties": {
        "receiptId": {
          "$ref": "#/$defs/Id"
        },
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "replayed": {
          "type": "boolean"
        },
        "revisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 1,
          "maxItems": 8
        },
        "deliveryClosed": {
          "const": true,
          "type": "boolean"
        }
      },
      "required": [
        "receiptId",
        "requestId",
        "replayed",
        "revisions",
        "deliveryClosed"
      ],
      "additionalProperties": false
    },
    "ToolPrepareProposal": {
      "type": "object",
      "properties": {
        "spec": {
          "$ref": "#/$defs/ToolProductionIntent"
        },
        "planSource": {
          "$ref": "#/$defs/RevisionRef",
          "description": "准备已交付方案的制作时，引用该作品当前方案的准确修订；无需复制方案或重新认可。不作为媒体输入。"
        },
        "replacesProposal": {
          "$ref": "#/$defs/ProposalRef",
          "description": "仅在用户明确替换某份报价时提供其准确 ID 和 digest。服务端核对同一会话、事项、方案与制作范围后撤销指定旧 ready 报价；普通备选和其他事项不受影响。新额度不足时旧报价仍已撤销，新提案不可执行。此意图不进入媒体执行 spec。"
        }
      },
      "required": [
        "spec"
      ],
      "additionalProperties": false
    },
    "ToolReadProposal": {
      "type": "object",
      "properties": {
        "proposalId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "proposalId"
      ],
      "additionalProperties": false,
      "description": "按 ID 读取提案当前事实；归属由宿主上下文核对，输入不接受 owner/conversation。"
    },
    "ToolReadRun": {
      "type": "object",
      "properties": {
        "runId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "runId"
      ],
      "additionalProperties": false,
      "description": "按 ID 读取运行当前事实（状态、issue、费用口径）；只读，不产生业务写入。"
    },
    "ToolListProduction": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "proposals",
            "runs"
          ]
        },
        "cursor": {
          "$ref": "#/$defs/Cursor"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 10
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false,
      "description": "分页发现当前会话的提案/运行索引；游标与既有分页同源，不接受任意过滤表达式。"
    },
    "ToolReadArtifact": {
      "$ref": "#/$defs/RevisionRef"
    },
    "ExecutionInput": {
      "type": "object",
      "properties": {
        "runId": {
          "$ref": "#/$defs/Id"
        },
        "snapshotId": {
          "$ref": "#/$defs/Id"
        },
        "operationId": {
          "$ref": "#/$defs/Id"
        },
        "attemptId": {
          "$ref": "#/$defs/Id"
        },
        "requestIdentity": {
          "$ref": "#/$defs/Id"
        },
        "operation": {
          "$ref": "#/$defs/OperationSpec"
        },
        "resolvedInputs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "slot": {
                "type": "integer",
                "minimum": 0,
                "maximum": 23
              },
              "blobId": {
                "$ref": "#/$defs/Id"
              },
              "digest": {
                "$ref": "#/$defs/Digest"
              }
            },
            "required": [
              "slot",
              "blobId",
              "digest"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 24
        }
      },
      "required": [
        "runId",
        "snapshotId",
        "operationId",
        "attemptId",
        "requestIdentity",
        "operation",
        "resolvedInputs"
      ],
      "additionalProperties": false,
      "description": "仅宿主到执行器；operation.model 为唯一账户/配置绑定，render 为 null。模型不能构造执行上下文。冻结文本按修订读取，媒体按 resolvedInputs 读取。"
    },
    "RecoveryQuery": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "runId": {
              "$ref": "#/$defs/Id"
            },
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "attemptId": {
              "$ref": "#/$defs/Id"
            },
            "requestIdentity": {
              "$ref": "#/$defs/Id"
            },
            "providerTaskId": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ProviderTaskId"
                },
                {
                  "type": "null"
                }
              ]
            },
            "accountBinding": {
              "$ref": "#/$defs/ModelBinding"
            },
            "kind": {
              "const": "provider",
              "type": "string"
            }
          },
          "required": [
            "runId",
            "operationId",
            "attemptId",
            "requestIdentity",
            "providerTaskId",
            "accountBinding",
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "runId": {
              "$ref": "#/$defs/Id"
            },
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "attemptId": {
              "$ref": "#/$defs/Id"
            },
            "requestIdentity": {
              "$ref": "#/$defs/Id"
            },
            "kind": {
              "const": "local",
              "type": "string"
            }
          },
          "required": [
            "runId",
            "operationId",
            "attemptId",
            "requestIdentity",
            "kind"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ExecutionObservation": {
      "type": "object",
      "properties": {
        "observationId": {
          "$ref": "#/$defs/Id"
        },
        "attemptId": {
          "$ref": "#/$defs/Id"
        },
        "state": {
          "type": "string",
          "enum": [
            "accepted",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "unknown"
          ]
        },
        "providerTaskId": {
          "anyOf": [
            {
              "$ref": "#/$defs/ProviderTaskId"
            },
            {
              "type": "null"
            }
          ]
        },
        "blob": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "id": {
                  "$ref": "#/$defs/Id"
                },
                "digest": {
                  "$ref": "#/$defs/Digest"
                },
                "mimeType": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 100
                }
              },
              "required": [
                "id",
                "digest",
                "mimeType"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "observedAt": {
          "$ref": "#/$defs/Time"
        },
        "message": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 1200
            },
            {
              "type": "null"
            }
          ]
        },
        "billing": {
          "anyOf": [
            {
              "$ref": "#/$defs/BillingFact"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "observationId",
        "attemptId",
        "state",
        "providerTaskId",
        "blob",
        "observedAt",
        "message",
        "billing"
      ],
      "additionalProperties": false
    },
    "ProviderTaskId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    },
    "OperationRequest": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "kind": {
              "const": "video",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/VideoParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "kind": {
              "const": "image",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/ImageParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "kind": {
              "const": "speech",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/SpeechParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "maxCreateAttempts": {
              "type": "integer",
              "const": 1
            },
            "kind": {
              "const": "render",
              "type": "string"
            },
            "model": {
              "type": "null"
            },
            "parameters": {
              "$ref": "#/$defs/RenderParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "maxCreateAttempts",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ProductionIntent": {
      "type": "object",
      "properties": {
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "inputRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 0,
          "maxItems": 8
        },
        "operations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/OperationRequest"
          },
          "minItems": 1,
          "maxItems": 24
        },
        "finalOutput": {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "operationId",
            "outputSlot"
          ],
          "additionalProperties": false
        },
        "maxSpend": {
          "$ref": "#/$defs/Money"
        }
      },
      "required": [
        "workId",
        "title",
        "inputRevisions",
        "operations",
        "finalOutput",
        "maxSpend"
      ],
      "additionalProperties": false
    },
    "MessageReferences": {
      "type": "object",
      "properties": {
        "artifacts": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "maxItems": 24
        },
        "proposalIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "maxItems": 24
        },
        "runIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "maxItems": 24
        },
        "materialBatchIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Id"
          },
          "maxItems": 24
        }
      },
      "required": [
        "artifacts",
        "proposalIds",
        "runIds",
        "materialBatchIds"
      ],
      "additionalProperties": false
    },
    "ProposalPage": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Proposal"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        },
        "watermark": {
          "$ref": "#/$defs/Cursor"
        }
      },
      "required": [
        "items",
        "nextCursor",
        "watermark"
      ],
      "additionalProperties": false
    },
    "ProposalIndexItem": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "state": {
          "type": "string",
          "enum": [
            "ready",
            "stale",
            "expired",
            "accepted"
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "digest": {
          "$ref": "#/$defs/Digest"
        },
        "expiresAt": {
          "$ref": "#/$defs/Time"
        },
        "acceptedRunId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "title",
        "state",
        "revision",
        "digest",
        "expiresAt",
        "acceptedRunId"
      ],
      "additionalProperties": false
    },
    "RunIndexItem": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "state": {
          "$ref": "#/$defs/RunState"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "proposalId": {
          "$ref": "#/$defs/Id"
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        },
        "updatedAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "id",
        "title",
        "state",
        "revision",
        "proposalId",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    },
    "ProductionIndexPage": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "proposals"
            },
            "items": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/ProposalIndexItem"
              },
              "minItems": 0,
              "maxItems": 50
            },
            "nextCursor": {
              "anyOf": [
                {
                  "$ref": "#/$defs/Cursor"
                },
                {
                  "type": "null"
                }
              ]
            },
            "watermark": {
              "$ref": "#/$defs/Cursor"
            }
          },
          "required": [
            "kind",
            "items",
            "nextCursor",
            "watermark"
          ],
          "additionalProperties": false,
          "description": "索引页复用既有分页顺序、游标校验与水位语义；只分页当前会话。"
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "runs"
            },
            "items": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/RunIndexItem"
              },
              "minItems": 0,
              "maxItems": 50
            },
            "nextCursor": {
              "anyOf": [
                {
                  "$ref": "#/$defs/Cursor"
                },
                {
                  "type": "null"
                }
              ]
            },
            "watermark": {
              "$ref": "#/$defs/Cursor"
            }
          },
          "required": [
            "kind",
            "items",
            "nextCursor",
            "watermark"
          ],
          "additionalProperties": false,
          "description": "索引页复用既有分页顺序、游标校验与水位语义；只分页当前会话。"
        }
      ],
      "description": "索引页复用既有分页顺序、游标校验与水位语义；只分页当前会话。"
    },
    "BillingFact": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "authoritative",
              "type": "string"
            },
            "billingFactId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "sourceRevision": {
              "type": "string",
              "pattern": "^(0|[1-9][0-9]{0,39})$"
            },
            "netAmount": {
              "$ref": "#/$defs/Money"
            },
            "final": {
              "type": "boolean"
            },
            "evidenceId": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "kind",
            "billingFactId",
            "sourceRevision",
            "netAmount",
            "final",
            "evidenceId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "unverified",
              "type": "string"
            },
            "reportedNetAmount": {
              "anyOf": [
                {
                  "$ref": "#/$defs/Money"
                },
                {
                  "type": "null"
                }
              ]
            },
            "evidenceId": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "kind",
            "reportedNetAmount",
            "evidenceId"
          ],
          "additionalProperties": false
        }
      ],
      "description": "账务事实针对外层 attempt。authoritative 使用可核实的供应商累计净费用、稳定事实ID、可比较的供应商修订；无证据则 unverified，不能由轮询次数或到达时间合成权威版本。"
    },
    "FeedbackNote": {
      "type": "object",
      "properties": {
        "applied": {
          "type": "boolean",
          "const": false
        },
        "disposition": {
          "type": "string",
          "enum": [
            "noted",
            "next_version"
          ]
        },
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "contentSource": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "applied",
        "disposition",
        "workId",
        "contentSource"
      ],
      "additionalProperties": false
    },
    "ProviderModelId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$",
      "description": "供应商型号标识；比业务 Id 宽，允许点、斜杠等型号字符，仍不含空白。"
    },
    "UserProfile": {
      "type": "object",
      "properties": {
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "bio": {
          "type": "string",
          "minLength": 0,
          "maxLength": 500
        }
      },
      "required": [
        "revision",
        "displayName",
        "bio"
      ],
      "additionalProperties": false
    },
    "SaveUserProfile": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "bio": {
          "type": "string",
          "minLength": 0,
          "maxLength": 500
        }
      },
      "required": [
        "commandId",
        "expectedRevision",
        "displayName",
        "bio"
      ],
      "additionalProperties": false
    },
    "SaveUserProfileReceipt": {
      "type": "object",
      "properties": {
        "profile": {
          "$ref": "#/$defs/UserProfile"
        },
        "replayed": {
          "type": "boolean"
        }
      },
      "required": [
        "profile",
        "replayed"
      ],
      "additionalProperties": false
    },
    "ImportedConfiguration": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "kind": {
          "type": "string",
          "enum": [
            "text",
            "image",
            "video",
            "speech",
            "material",
            "trend"
          ]
        },
        "name": {
          "type": "string"
        },
        "endpoint": {
          "type": "string"
        },
        "modelId": {
          "type": [
            "string",
            "null"
          ]
        },
        "apiKey": {
          "type": [
            "string",
            "null"
          ]
        },
        "details": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "kind",
        "name",
        "endpoint",
        "modelId",
        "apiKey",
        "details"
      ]
    },
    "ImportedSettings": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ImportedConfiguration"
      },
      "description": "尚未迁为可执行连接的旧配置，只供设置页面查看，不进入能力目录。"
    },
    "ConnectionModel": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "kind": {
          "enum": [
            "text",
            "image",
            "video",
            "speech"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "modelId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "features": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 200
          }
        },
        "contextWindowTokens": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "maxOutputTokens": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "enabled": {
          "type": "boolean"
        },
        "isDefault": {
          "type": "boolean"
        },
        "baseUrl": {
          "type": [
            "string",
            "null"
          ],
          "description": "型号专用接口；省略或 null 使用连接默认地址。合并同一凭据的历史不同接口时保留原目标。"
        },
        "thinkingLevel": {
          "description": "文本型号的推理档位；省略等同 default（Pi 原生默认，按该型号能力夹取）。非文本型号不保存具体档位。",
          "anyOf": [
            {
              "$ref": "#/$defs/ThinkingLevel"
            },
            {
              "const": "default"
            }
          ]
        }
      },
      "required": [
        "id",
        "kind",
        "name",
        "modelId",
        "features",
        "contextWindowTokens",
        "maxOutputTokens",
        "enabled",
        "isDefault"
      ],
      "additionalProperties": false
    },
    "ProviderConnection": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "protocol": {
          "description": "openai 是唯一的 OpenAI 供应商连接，承载 text/image/speech 且共用 Key；minimax 承载 speech/video；ark 承载 image/video，wan 只承载 video（万相视频走其真实媒体端点，不是 OpenAI 文本兼容协议）。openai-chat-completions/anthropic-messages 是历史可读兼容串，不得重新登记退役的文本/图片/配音能力。",
          "enum": [
            "openai",
            "openai-chat-completions",
            "anthropic-messages",
            "ark",
            "minimax",
            "wan"
          ]
        },
        "baseUrl": {
          "type": "string",
          "minLength": 1
        },
        "apiKey": {
          "type": [
            "string",
            "null"
          ]
        },
        "enabled": {
          "type": "boolean"
        },
        "models": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ConnectionModel"
          }
        }
      },
      "required": [
        "id",
        "name",
        "protocol",
        "baseUrl",
        "apiKey",
        "enabled",
        "models"
      ],
      "additionalProperties": false
    },
    "ProviderConnectionSettings": {
      "type": "object",
      "properties": {
        "revision": {
          "type": "integer",
          "minimum": 0
        },
        "connections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ProviderConnection"
          }
        },
        "modelStatuses": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "modelEntryId": {
                "type": "string",
                "minLength": 1
              },
              "unavailableReason": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "thinking": {
                "description": "只读推理能力：null 表示精确身份未核实或该条目不是文本，不等于不支持推理；已知非推理为 levels:[off]。",
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "levels": {
                        "type": "array",
                        "items": {
                          "$ref": "#/$defs/ThinkingLevel"
                        },
                        "minItems": 1
                      },
                      "defaultLevel": {
                        "$ref": "#/$defs/ThinkingLevel"
                      }
                    },
                    "required": [
                      "levels",
                      "defaultLevel"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "modelEntryId",
              "unavailableReason",
              "thinking"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "revision",
        "connections",
        "modelStatuses"
      ],
      "additionalProperties": false
    },
    "SaveProviderConnection": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 0
        },
        "connection": {
          "$ref": "#/$defs/ProviderConnection"
        }
      },
      "required": [
        "commandId",
        "expectedRevision",
        "connection"
      ],
      "additionalProperties": false
    },
    "SaveProviderConnectionReceipt": {
      "type": "object",
      "properties": {
        "revision": {
          "type": "integer",
          "minimum": 0
        },
        "replayed": {
          "type": "boolean"
        }
      },
      "required": [
        "revision",
        "replayed"
      ],
      "additionalProperties": false
    },
    "AvailableProviderModels": {
      "type": "object",
      "properties": {
        "models": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ProviderDirectoryModel"
          }
        },
        "hasMore": {
          "type": "boolean"
        },
        "syncedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "models",
        "hasMore",
        "syncedAt"
      ],
      "additionalProperties": false
    },
    "ProviderDirectoryModel": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "kinds": {
          "type": "array",
          "items": {
            "enum": [
              "text",
              "image",
              "video",
              "speech"
            ]
          },
          "uniqueItems": true
        },
        "status": {
          "enum": [
            "listed",
            "retiring",
            "retired"
          ]
        },
        "contextWindowTokens": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "maxOutputTokens": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        }
      },
      "required": [
        "id",
        "name",
        "kinds",
        "status",
        "contextWindowTokens",
        "maxOutputTokens"
      ],
      "additionalProperties": false
    },
    "ThinkingLevel": {
      "description": "Pi 1.4.0 的具体推理档位；不含配置侧的 default 语义。实际可用档位由型号能力决定。",
      "enum": [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "WorkStage": {
      "type": "string",
      "enum": [
        "content",
        "plan",
        "video"
      ]
    },
    "ContentSource": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "artifact_revision",
              "type": "string"
            },
            "artifactId": {
              "$ref": "#/$defs/Id"
            },
            "revisionId": {
              "$ref": "#/$defs/Id"
            },
            "digest": {
              "$ref": "#/$defs/Digest"
            }
          },
          "required": [
            "kind",
            "artifactId",
            "revisionId",
            "digest"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "message_text",
              "type": "string"
            },
            "messageId": {
              "$ref": "#/$defs/Id"
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32000
            },
            "author": {
              "type": "string",
              "enum": [
                "user",
                "assistant"
              ]
            }
          },
          "required": [
            "kind",
            "messageId",
            "text",
            "author"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ContentSourceInput": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "artifact_revision",
              "type": "string"
            },
            "artifactId": {
              "$ref": "#/$defs/Id"
            },
            "revisionId": {
              "$ref": "#/$defs/Id"
            },
            "digest": {
              "$ref": "#/$defs/Digest"
            }
          },
          "required": [
            "kind",
            "artifactId",
            "revisionId",
            "digest"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "message_text",
              "type": "string"
            },
            "messageId": {
              "$ref": "#/$defs/Id"
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32000
            }
          },
          "required": [
            "kind",
            "messageId",
            "text"
          ],
          "additionalProperties": false
        }
      ]
    },
    "DeliveryItemSource": {
      "type": "object",
      "properties": {
        "kind": {
          "const": "delivery_item",
          "type": "string"
        },
        "itemIndex": {
          "type": "integer",
          "minimum": 0,
          "maximum": 7,
          "description": "仅限同一次 deliver_artifacts 事务内使用：指向本批第 itemIndex 项同 work 的 content 主稿；保存时解析为真实内容修订，不落库。"
        }
      },
      "required": [
        "kind",
        "itemIndex"
      ],
      "additionalProperties": false
    },
    "StageConfirmation": {
      "type": "object",
      "properties": {
        "workId": {
          "$ref": "#/$defs/Id"
        },
        "action": {
          "type": "string",
          "enum": [
            "approve_content",
            "approve_content_continue",
            "approve_plan",
            "finalize_video"
          ]
        },
        "subject": {
          "$ref": "#/$defs/ContentSourceInput"
        },
        "next": {
          "const": "prepare_production",
          "type": "string",
          "description": "仅 approve_plan 可带：记录方案认可的同时，就这份准确方案排一次准备制作的请求；报价与授权仍由提案确认完成，不是本字段的许可。"
        }
      },
      "required": [
        "workId",
        "action",
        "subject"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "next": {
                "const": "prepare_production"
              }
            },
            "required": [
              "next"
            ]
          },
          "then": {
            "properties": {
              "action": {
                "const": "approve_plan"
              }
            }
          }
        }
      ]
    },
    "WorkStageView": {
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "#/$defs/WorkStage"
        },
        "draft": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ]
        },
        "approved": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ]
        },
        "approvedAt": {
          "anyOf": [
            {
              "$ref": "#/$defs/Time"
            },
            {
              "type": "null"
            }
          ]
        },
        "confirmationId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "upstreamStale": {
          "type": "boolean"
        },
        "proposalId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "confirmationAction": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "approve_content",
                "approve_content_continue",
                "approve_plan",
                "finalize_video"
              ]
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "stage",
        "draft",
        "approved",
        "approvedAt",
        "confirmationId",
        "confirmationAction",
        "upstreamStale",
        "proposalId",
        "runId"
      ],
      "additionalProperties": false
    },
    "Work": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "stage": {
          "$ref": "#/$defs/WorkStage"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "stages": {
          "type": "object",
          "properties": {
            "content": {
              "$ref": "#/$defs/WorkStageView"
            },
            "plan": {
              "$ref": "#/$defs/WorkStageView"
            },
            "video": {
              "$ref": "#/$defs/WorkStageView"
            }
          },
          "required": [
            "content",
            "plan",
            "video"
          ],
          "additionalProperties": false
        },
        "createdAt": {
          "$ref": "#/$defs/Time"
        },
        "updatedAt": {
          "$ref": "#/$defs/Time"
        }
      },
      "required": [
        "id",
        "title",
        "stage",
        "revision",
        "stages",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    },
    "MaterialQuery": {
      "type": "object",
      "properties": {
        "provider": {
          "$ref": "#/$defs/MaterialProvider"
        },
        "kind": {
          "type": "string",
          "enum": [
            "image",
            "video",
            "audio"
          ]
        },
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      },
      "required": [
        "provider",
        "kind",
        "query",
        "limit"
      ],
      "additionalProperties": false
    },
    "MaterialBatch": {
      "type": "object",
      "properties": {
        "batchId": {
          "$ref": "#/$defs/Id"
        },
        "workId": {
          "$ref": "#/$defs/Id",
          "description": "搜索时关联的创作；独立聊天找素材时省略。采用沿用原批次的归属。"
        },
        "revision": {
          "type": "integer",
          "const": 1
        },
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "toolCallId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "query": {
          "$ref": "#/$defs/MaterialQuery"
        },
        "retrievedAt": {
          "$ref": "#/$defs/Time"
        },
        "results": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/MaterialCandidate"
          },
          "maxItems": 10
        },
        "messageId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "batchId",
        "revision",
        "requestId",
        "toolCallId",
        "query",
        "retrievedAt",
        "results",
        "messageId"
      ],
      "additionalProperties": false
    },
    "MaterialBatchIndexItem": {
      "type": "object",
      "properties": {
        "batchId": {
          "$ref": "#/$defs/Id"
        },
        "requestId": {
          "$ref": "#/$defs/Id"
        },
        "messageId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "query": {
          "$ref": "#/$defs/MaterialQuery"
        },
        "retrievedAt": {
          "$ref": "#/$defs/Time"
        },
        "resultCount": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10
        }
      },
      "required": [
        "batchId",
        "requestId",
        "messageId",
        "query",
        "retrievedAt",
        "resultCount"
      ],
      "additionalProperties": false
    },
    "StageDraft": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "workId": {
              "$ref": "#/$defs/Id"
            },
            "stage": {
              "const": "content",
              "type": "string"
            },
            "itemIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 7
            },
            "source": {
              "type": "null"
            },
            "proposalRef": {
              "type": "null"
            }
          },
          "required": [
            "workId",
            "stage",
            "itemIndex",
            "source",
            "proposalRef"
          ],
          "additionalProperties": false,
          "description": "内容草稿：新写或修改的正文均使用 source:null、proposalRef:null；修改基准由对应 item.baseRevisionId 指定。"
        },
        {
          "type": "object",
          "properties": {
            "workId": {
              "$ref": "#/$defs/Id"
            },
            "stage": {
              "const": "plan",
              "type": "string"
            },
            "itemIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 7
            },
            "source": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ContentSourceInput"
                },
                {
                  "$ref": "#/$defs/DeliveryItemSource"
                }
              ],
              "description": "指向这条视频采用的内容：既有内容修订/消息文本，或仅限本批交付的 delivery_item 临时引用（解析后不留 itemIndex）。"
            },
            "proposalRef": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ProposalRef"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "workId",
            "stage",
            "itemIndex",
            "source",
            "proposalRef"
          ],
          "additionalProperties": false,
          "description": "画面声音方案：source 指向这条视频采用的内容；有有效制作提案时填 proposalRef，否则 null。"
        }
      ]
    },
    "ToolStartWork": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    },
    "ToolReadWork": {
      "type": "object",
      "properties": {
        "workId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "workId"
      ],
      "additionalProperties": false
    },
    "ToolConfirmStage": {
      "type": "object",
      "properties": {
        "workId": {
          "$ref": "#/$defs/Id"
        },
        "action": {
          "type": "string",
          "enum": [
            "approve_content",
            "approve_content_continue",
            "approve_plan",
            "finalize_video"
          ]
        },
        "subject": {
          "$ref": "#/$defs/ContentSourceInput"
        }
      },
      "required": [
        "workId",
        "action",
        "subject"
      ],
      "additionalProperties": false
    },
    "ToolReadMaterialBatch": {
      "type": "object",
      "properties": {
        "batchId": {
          "$ref": "#/$defs/Id"
        }
      },
      "required": [
        "batchId"
      ],
      "additionalProperties": false
    },
    "ToolRecordWorkFeedback": {
      "type": "object",
      "properties": {
        "workId": {
          "$ref": "#/$defs/Id"
        },
        "artifactId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "baseRevisionId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "segment": {
          "type": "object",
          "properties": {
            "runId": {
              "$ref": "#/$defs/Id"
            },
            "segmentId": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "runId",
            "segmentId"
          ],
          "additionalProperties": false,
          "description": "意见针对的那次运行片段；与请求 target.segment 同构。"
        }
      },
      "required": [
        "workId",
        "artifactId",
        "baseRevisionId"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "artifactId": {
                "not": {
                  "type": "null"
                }
              }
            },
            "required": [
              "artifactId"
            ]
          },
          "then": {
            "properties": {
              "baseRevisionId": {
                "not": {
                  "type": "null"
                }
              }
            },
            "required": [
              "baseRevisionId"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "artifactId": {
                "type": "null"
              }
            },
            "required": [
              "artifactId"
            ]
          },
          "then": {
            "properties": {
              "baseRevisionId": {
                "type": "null"
              }
            }
          }
        }
      ]
    },
    "ToolOperationRequest": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "kind": {
              "const": "video",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/VideoParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "kind": {
              "const": "image",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/ImageParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "kind": {
              "const": "speech",
              "type": "string"
            },
            "model": {
              "$ref": "#/$defs/ModelBinding"
            },
            "parameters": {
              "$ref": "#/$defs/SpeechParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            },
            "inputs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/InputRef"
              },
              "minItems": 1,
              "maxItems": 24
            },
            "kind": {
              "const": "render",
              "type": "string"
            },
            "model": {
              "type": "null"
            },
            "parameters": {
              "$ref": "#/$defs/RenderParameters"
            }
          },
          "required": [
            "operationId",
            "outputSlot",
            "inputs",
            "kind",
            "model",
            "parameters"
          ],
          "additionalProperties": false
        }
      ]
    },
    "ToolProductionIntent": {
      "type": "object",
      "properties": {
        "workId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "inputRevisions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RevisionRef"
          },
          "minItems": 0,
          "maxItems": 8
        },
        "operations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ToolOperationRequest"
          },
          "minItems": 1,
          "maxItems": 24
        },
        "finalOutput": {
          "type": "object",
          "properties": {
            "operationId": {
              "$ref": "#/$defs/Id"
            },
            "outputSlot": {
              "$ref": "#/$defs/Id"
            }
          },
          "required": [
            "operationId",
            "outputSlot"
          ],
          "additionalProperties": false
        },
        "maxSpend": {
          "$ref": "#/$defs/Money"
        }
      },
      "required": [
        "workId",
        "title",
        "inputRevisions",
        "operations",
        "finalOutput",
        "maxSpend"
      ],
      "additionalProperties": false
    },
    "LibraryVideo": {
      "type": "object",
      "description": "作品库条目：一次用户定稿的最终视频修订。entry identity 是 video.revisionId；plan/content 是该视频制作时冻结的方案与内容来源，缺失为 null（历史无准确来源时不拿当前稿补齐），不随 work 当前稿变化。",
      "properties": {
        "video": {
          "$ref": "#/$defs/RevisionRef"
        },
        "workId": {
          "$ref": "#/$defs/Id"
        },
        "conversationId": {
          "$ref": "#/$defs/Id"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "finalizedAt": {
          "$ref": "#/$defs/Time"
        },
        "plan": {
          "anyOf": [
            {
              "$ref": "#/$defs/RevisionRef"
            },
            {
              "type": "null"
            }
          ]
        },
        "content": {
          "anyOf": [
            {
              "$ref": "#/$defs/ContentSource"
            },
            {
              "type": "null"
            }
          ]
        },
        "originMessageId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "narrationText": {
          "type": [
            "string",
            "null"
          ],
          "description": "该视频实际采用的可追溯独立旁白，沿音轨及不可变制作快照读取；复用保留原来源，多段按播放顺序换行。无逐字记录或来源不完整为 null，不从方案正文推测。"
        },
        "audioSummary": {
          "$ref": "#/$defs/AudioSummary"
        }
      },
      "required": [
        "video",
        "workId",
        "conversationId",
        "title",
        "finalizedAt",
        "plan",
        "content",
        "originMessageId",
        "narrationText"
      ],
      "additionalProperties": false
    },
    "LibraryVideoPage": {
      "type": "object",
      "description": "作品库分页；按首次定稿时间倒序、revisionId 稳定排序，条目按 video.revisionId 去重（重复定稿不顶到最前）。库在进入时整页读取，没有事件水印。",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/LibraryVideo"
          },
          "minItems": 0,
          "maxItems": 50
        },
        "nextCursor": {
          "anyOf": [
            {
              "$ref": "#/$defs/Cursor"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "items",
        "nextCursor"
      ],
      "additionalProperties": false
    },
    "MaterialProvider": {
      "type": "string",
      "enum": [
        "pexels",
        "pixabay",
        "unsplash",
        "coverr",
        "wikimedia",
        "nasa",
        "met",
        "cleveland",
        "archive",
        "freetouse",
        "incompetech"
      ],
      "description": "已适配的免费素材来源；可用性以启用配置、实际下载结果与许可为准，目录成功不代表采用成功。"
    },
    "KeyedMaterialSettings": {
      "type": "object",
      "properties": {
        "serviceId": {
          "type": "string",
          "enum": [
            "pixabay",
            "unsplash",
            "coverr"
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "credentialConfigured": {
          "type": "boolean"
        },
        "writeUnavailableReason": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            },
            {
              "type": "null"
            }
          ]
        },
        "apiKey": {
          "type": [
            "string",
            "null"
          ],
          "description": "完整 Key 仅设置 GET 返回，供本机个人页面查看；保存回执省略，不进入 Bootstrap、事件或 Agent 上下文。"
        }
      },
      "required": [
        "serviceId",
        "revision",
        "enabled",
        "credentialConfigured",
        "writeUnavailableReason"
      ],
      "additionalProperties": false
    },
    "KeylessMaterialSettings": {
      "type": "object",
      "properties": {
        "serviceId": {
          "type": "string",
          "enum": [
            "wikimedia",
            "nasa",
            "met",
            "cleveland",
            "archive",
            "freetouse",
            "incompetech",
            "douyin-music",
            "tiktok-sounds"
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        },
        "writeUnavailableReason": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "serviceId",
        "revision",
        "enabled",
        "writeUnavailableReason"
      ],
      "additionalProperties": false
    },
    "SaveKeylessServiceSettings": {
      "type": "object",
      "properties": {
        "commandId": {
          "$ref": "#/$defs/Id"
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "enabled": {
          "type": "boolean"
        }
      },
      "required": [
        "commandId",
        "expectedRevision",
        "enabled"
      ],
      "additionalProperties": false,
      "description": "免 Key 素材服务（wikimedia/nasa/met/cleveland/archive）与 newsnow 之外的 keyless 保存体；只改启停。"
    },
    "AudioSummary": {
      "type": "object",
      "properties": {
        "original": {
          "type": "array",
          "maxItems": 24,
          "items": {
            "type": "object",
            "properties": {
              "segmentId": {
                "$ref": "#/$defs/Id"
              },
              "gain": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "sourceText": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "textCoverage": {
                "type": "string",
                "enum": [
                  "full_source",
                  "source_excerpt",
                  "unknown",
                  "muted"
                ]
              }
            },
            "required": [
              "segmentId",
              "gain",
              "sourceText",
              "textCoverage"
            ],
            "additionalProperties": false
          }
        },
        "music": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "source": {
                  "$ref": "#/$defs/MediaProvenance"
                },
                "sourceStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 86400000
                },
                "sourceDurationMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 86400000
                },
                "timelineStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "playDurationMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 120000
                },
                "repeat": {
                  "type": "boolean"
                },
                "gain": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "fadeInMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "fadeOutMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "duckUnderNarration": {
                  "type": "boolean"
                }
              },
              "required": [
                "source",
                "sourceStartMs",
                "sourceDurationMs",
                "timelineStartMs",
                "playDurationMs",
                "repeat",
                "gain",
                "fadeInMs",
                "fadeOutMs",
                "duckUnderNarration"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "narration": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "text": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "providerName": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "modelName": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "voiceName": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "timelineStartMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120000
                },
                "gain": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                }
              },
              "required": [
                "text",
                "providerName",
                "modelName",
                "voiceName",
                "timelineStartMs",
                "gain"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "original",
        "music",
        "narration"
      ],
      "additionalProperties": false,
      "description": "从不可变spec与精确生成来源计算的只读声音摘要，不独立持久化。独立配音、原声与音乐分别保留证据；未知原声不清空已知配音，歌曲不算旁白。"
    }
  }
};
export default contractsSchema;
