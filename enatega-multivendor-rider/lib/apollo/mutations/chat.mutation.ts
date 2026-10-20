import { gql } from "@apollo/client";

export const SEND_CHAT_MESSAGE =
  // @multi-vendor-only
  gql`
    mutation SendChatMessage($orderId: ID!, $messageInput: ChatMessageInput!) {
      sendChatMessage(message: $messageInput, orderId: $orderId) {
        success
        message
        data {
          id
          message
          image
          user {
            id
            name
          }
          createdAt
        }
      }
    }
  `;
