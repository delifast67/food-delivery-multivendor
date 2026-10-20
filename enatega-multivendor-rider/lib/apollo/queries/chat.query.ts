import { gql } from "@apollo/client";

export const CHAT =
  // @multi-vendor-only
  gql`
    query Chat($order: ID!) {
      chat(order: $order) {
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
  `;
