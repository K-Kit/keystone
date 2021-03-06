import type { KeystoneSystem, SerializedAdminMeta } from '@keystone-next/types';
import hashString from '@emotion/hash';
import {
  executeSync,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
  parse,
  FragmentDefinitionNode,
  SelectionNode,
} from 'graphql';
import { staticAdminMetaQuery } from '../admin-meta-graphql';
import Path from 'path';

type AppTemplateOptions = { configFileExists: boolean; projectAdminPath: string };

export const appTemplate = (
  system: KeystoneSystem,
  { configFileExists, projectAdminPath }: AppTemplateOptions
) => {
  const { graphQLSchema, adminMeta, allViews } = system;

  const result = executeSync({
    document: staticAdminMetaQuery,
    schema: graphQLSchema,
    contextValue: { isAdminUIBuildProcess: true },
  });
  if (result.errors) {
    throw result.errors[0];
  }
  const adminMetaQueryResultHash = hashString(JSON.stringify(result.data!.keystone.adminMeta));
  const viewPaths = allViews.map(views =>
    Path.isAbsolute(views) ? Path.relative(Path.join(projectAdminPath, 'pages'), views) : views
  );
  // -- TEMPLATE START
  return `
import React from 'react';

import { KeystoneProvider } from '@keystone-next/admin-ui/context';
import { ErrorBoundary } from '@keystone-next/admin-ui/components';
import { Core } from '@keystone-ui/core';

${viewPaths.map((views, i) => `import * as view${i} from "${views}"`).join('\n')}

${
  configFileExists
    ? `import * as adminConfig from "../../../admin/config";`
    : 'const adminConfig = {};'
}

const fieldViews = [${allViews.map((x, i) => `view${i}`)}];

const lazyMetadataQuery = ${JSON.stringify(getLazyMetadataQuery(graphQLSchema, adminMeta))};

export default function App({ Component, pageProps }) {
  return (
    <Core>
      <KeystoneProvider
        adminConfig={adminConfig}
        adminMetaHash="${adminMetaQueryResultHash}"
        fieldViews={fieldViews}
        lazyMetadataQuery={lazyMetadataQuery}
      >
        <ErrorBoundary>
          <Component {...pageProps} />
        </ErrorBoundary>
      </KeystoneProvider>
    </Core>
  );
}
  `;
  // -- TEMPLATE END
};

function getLazyMetadataQuery(graphqlSchema: GraphQLSchema, adminMeta: SerializedAdminMeta) {
  const selections = (parse(`fragment x on y {
    keystone {
      adminMeta {
        lists {
          key
          isHidden
          fields {
            path
            createView {
              fieldMode
            }
          }
        }
      }
    }
  }`).definitions[0] as FragmentDefinitionNode).selectionSet.selections as SelectionNode[];

  const queryType = graphqlSchema.getQueryType();
  if (queryType) {
    const fields = queryType.getFields();
    if (fields['authenticatedItem'] !== undefined) {
      const authenticatedItemType = fields['authenticatedItem'].type;
      if (
        !(authenticatedItemType instanceof GraphQLUnionType) ||
        authenticatedItemType.name !== 'AuthenticatedItem'
      ) {
        throw new Error(
          `The type of Query.authenticatedItem must be a type named AuthenticatedItem and be a union of types that refer to Keystone lists but it is "${authenticatedItemType.toString()}"`
        );
      }
      for (const type of authenticatedItemType.getTypes()) {
        const fields = type.getFields();
        if (adminMeta.lists[type.name] === undefined) {
          throw new Error(
            `All members of the AuthenticatedItem union must refer to Keystone lists but "${type.name}" is in the AuthenticatedItem union but is not a Keystone list`
          );
        }
        const list = adminMeta.lists[type.name];
        let labelGraphQLField = fields[list.labelField];
        if (labelGraphQLField === undefined) {
          throw new Error(
            `The labelField for the list "${list.key}" is "${list.labelField}" but the GraphQL type does not have a field named "${list.labelField}"`
          );
        }
        let labelGraphQLFieldType = labelGraphQLField.type;
        if (labelGraphQLFieldType instanceof GraphQLNonNull) {
          labelGraphQLFieldType = labelGraphQLFieldType.ofType;
        }
        if (!(labelGraphQLFieldType instanceof GraphQLScalarType)) {
          throw new Error(
            `Label fields must be scalar GraphQL types but the labelField "${list.labelField}" on the list "${list.key}" is not a scalar type`
          );
        }
        const requiredArgs = labelGraphQLField.args.filter(
          arg => arg.defaultValue === undefined && arg.type instanceof GraphQLNonNull
        );
        if (requiredArgs.length) {
          throw new Error(
            `Label fields must have no required arguments but the labelField "${list.labelField}" on the list "${list.key}" has a required argument "${requiredArgs[0].name}"`
          );
        }
      }

      selections.push({
        kind: 'Field',
        name: { kind: 'Name', value: 'authenticatedItem' },
        selectionSet: {
          kind: 'SelectionSet',
          selections: authenticatedItemType.getTypes().map(({ name }) => ({
            kind: 'InlineFragment',
            typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: name } },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: adminMeta.lists[name].labelField } },
              ],
            },
          })),
        },
      });
    }
  }

  // We're returning the complete query AST here for explicit-ness
  return {
    kind: 'Document',
    definitions: [
      {
        kind: 'OperationDefinition',
        operation: 'query',
        selectionSet: { kind: 'SelectionSet', selections },
      },
    ],
  };
}
