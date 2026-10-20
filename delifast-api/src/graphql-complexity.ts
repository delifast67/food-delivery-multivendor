import {
  GraphQLError,
  Kind,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from "graphql";

/** Conservative structural budget, including every fragment use before execution.
 * Directives and merged fields do not reduce the budget. Expansion itself is
 * bounded so a small fragment DAG cannot make validation exponential.
 */
export function complexityRule(context: ValidationContext) {
  return {
    Document() {
      const document = context.getDocument();
      const operations = document.definitions.filter(
        (node) => node.kind === Kind.OPERATION_DEFINITION,
      );
      const reject = (message = "Requête trop complexe") =>
        context.reportError(new GraphQLError(message, {
          extensions: { code: "QUERY_TOO_COMPLEX" },
        }));
      if (operations.length > 1) {
        reject("Une seule opération est autorisée");
        return;
      }
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const node of document.definitions) {
        if (node.kind === Kind.FRAGMENT_DEFINITION) fragments.set(node.name.value, node);
      }
      let fields = 0;
      let visits = 0;
      let exceeded = false;
      const active = new Set<string>();
      function walk(set: SelectionSetNode, depth: number) {
        for (const node of set.selections) {
          if (exceeded) return;
          if (++visits > 1000) { exceeded = true; return; }
          if (node.kind === Kind.FIELD) {
            if (++fields > 100 || depth + 1 > 10) { exceeded = true; return; }
            if (node.selectionSet) walk(node.selectionSet, depth + 1);
          } else if (node.kind === Kind.INLINE_FRAGMENT) {
            walk(node.selectionSet, depth);
          } else {
            const name = node.name.value;
            // Standard GraphQL rules report unknown fragments and cycles too.
            if (active.has(name)) { exceeded = true; return; }
            const fragment = fragments.get(name);
            if (!fragment) continue;
            active.add(name);
            walk(fragment.selectionSet, depth);
            active.delete(name);
          }
        }
      }
      for (const operation of operations) walk(operation.selectionSet, 0);
      if (exceeded) reject();
    },
  };
}
