/* ----------------------------------------------------------------------------------
 * Copyright 2022-2023 Informal Systems
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE in the project root for license information.
 * --------------------------------------------------------------------------------- */

/**
 * Name collection for Quint name resolution.
 *
 * @author Gabriela Moreira
 *
 * @module
 */

import { IRVisitor } from '../ir/IRVisitor'
import { QuintError } from '../quintError'
import {
  QuintAssume,
  QuintConst,
  QuintExport,
  QuintImport,
  QuintInstance,
  QuintModule,
  QuintOpDef,
  QuintTypeDef,
  QuintVar,
  qualifier,
} from '../ir/quintIr'
import {
  DefinitionsByModule,
  DefinitionsByName,
  LookupDefinition,
  LookupTable,
  addNamespacesToDef,
  builtinNames,
  copyNames,
} from './base'
import {
  moduleNotFoundError,
  nameNotFoundError,
  paramIsNotAConstantError,
  paramNotFoundError,
  selfReferenceError,
} from './importErrors'
import { compact } from 'lodash'

/**
 * Collects all top-level definitions in Quint modules. Used internally by
 * `NameResolver`. Also handles imports, instances and exports, collecting
 * definitions from those statements and managing their level of visibility.
 */
export class NameCollector implements IRVisitor {
  definitionsByName: DefinitionsByName = new Map()
  definitionsByModule: DefinitionsByModule = new Map()
  errors: QuintError[] = []
  table: LookupTable = new Map()

  // the current depth of operator definitions: top-level defs are depth 0
  // FIXME(#1279): The walk* functions update this value, but they need to be
  // initialized to -1 here for that to work on all scenarios.
  definitionDepth: number = -1

  private currentModuleName: string = ''

  enterModule(module: QuintModule): void {
    this.currentModuleName = module.name
    this.definitionsByName = new Map()

    if (this.definitionsByModule.has(module.name)) {
      const message = `Module with name '${module.name}' was already defined`
      this.errors.push({ code: 'QNT102', message, reference: module.id, data: {} })
    }
  }

  exitModule(module: QuintModule): void {
    this.definitionsByModule.set(module.name, this.definitionsByName)
  }

  enterVar(def: QuintVar): void {
    this.collectDefinition(def)
  }

  enterConst(def: QuintConst): void {
    this.collectDefinition(def)
  }

  enterOpDef(def: QuintOpDef): void {
    // FIXME (#1013): This should collect the type annotation, but something
    // breaks in the type checker if we do. We should fix that and then ensure
    // that we collect type annotations here.
    if (this.definitionDepth === 0) {
      // collect only top-level definitions
      this.collectDefinition({ ...def, typeAnnotation: undefined, depth: this.definitionDepth })
    }
  }

  enterTypeDef(def: QuintTypeDef): void {
    this.collectDefinition(def)
  }

  enterAssume(def: QuintAssume): void {
    this.collectDefinition(def)
  }

  enterInstance(decl: QuintInstance): void {
    // Copy defs from the module being instantiated
    if (decl.protoName === this.currentModuleName) {
      // Importing current module
      this.errors.push(selfReferenceError(decl))
      return
    }

    const moduleTable = this.definitionsByModule.get(decl.protoName)

    if (!moduleTable) {
      // Instantiating a non-existing module
      this.errors.push(moduleNotFoundError(decl))
      return
    }

    const instanceTable = new Map([...moduleTable.entries()])
    if (decl.qualifiedName) {
      // Add the qualifier to `definitionsMyModule` map with a copy of the
      // definitions, so if there is an export of that qualifier, we know which
      // definitions to export
      this.definitionsByModule.set(decl.qualifiedName, instanceTable)
    }

    // For each override, check if the name exists in the instantiated module and is a constant.
    // If so, update the value definition to point to the expression being overriden
    decl.overrides.forEach(([param, ex]) => {
      const constDef = instanceTable.get(param.name)

      if (!constDef) {
        this.errors.push(paramNotFoundError(decl, param))
        return
      }

      if (constDef.kind !== 'const') {
        this.errors.push(paramIsNotAConstantError(decl, param))
        return
      }

      // Update the definition to point to the expression being overriden
      instanceTable.set(param.name, { ...constDef, id: ex.id })
    })

    // All names from the instanced module should be acessible with the instance namespace
    // So, copy them to the current module's lookup table
    const newDefs = copyNames(instanceTable, decl.qualifiedName, true)
    this.collectDefinitions(newDefs, decl)
  }

  enterImport(decl: QuintImport): void {
    if (decl.protoName === this.currentModuleName) {
      // Importing current module
      this.errors.push(selfReferenceError(decl))
      return
    }

    const moduleTable = this.definitionsByModule.get(decl.protoName)

    if (!moduleTable) {
      // Importing non-existing module
      this.errors.push(moduleNotFoundError(decl))
      return
    }

    if (decl.qualifiedName) {
      // Add the qualifier to `definitionsMyModule` map with a copy of the
      // definitions, so if there is an export of that qualifier, we know which
      // definitions to export
      const newTable = new Map([...moduleTable.entries()])
      this.definitionsByModule.set(decl.qualifiedName, newTable)
    }

    const importableDefinitions = copyNames(moduleTable, qualifier(decl), true)

    if (!decl.defName || decl.defName === '*') {
      // Imports all definitions
      this.collectDefinitions(importableDefinitions, decl)
      return
    }

    // Tries to find a specific definition, reporting an error if not found
    const newDef = importableDefinitions.get(decl.defName)
    if (!newDef) {
      this.errors.push(nameNotFoundError(decl))
      return
    }

    this.collectDefinition(newDef, decl)
  }

  // Imported names are copied with a scope since imports are not transitive by
  // default. Exporting needs to turn those names into unhidden ones so, when
  // the current module is imported, the names are accessible. Note that it is
  // also possible to export names that were not previously imported via `import`.
  enterExport(decl: QuintExport) {
    if (decl.protoName === this.currentModuleName) {
      // Exporting current module
      this.errors.push(selfReferenceError(decl))
      return
    }

    const moduleTable = this.definitionsByModule.get(decl.protoName)
    if (!moduleTable) {
      // Exporting non-existing module
      this.errors.push(moduleNotFoundError(decl))
      return
    }

    const exportableDefinitions = copyNames(moduleTable, qualifier(decl))

    if (!decl.defName || decl.defName === '*') {
      // Export all definitions
      this.collectDefinitions(exportableDefinitions, decl)
      return
    }

    // Tries to find a specific definition, reporting an error if not found
    const newDef = exportableDefinitions.get(decl.defName)

    if (!newDef) {
      this.errors.push(nameNotFoundError(decl))
      return
    }

    this.collectDefinition(newDef, decl)
  }

  /** Public interface to manipulate the collected definitions. Used by
   * `NameResolver` to add and remove scoped definitions */

  /**
   * Collects a definition. If the identifier is an underscore or a built-in
   * name, the definition is not collected. If the identifier conflicts with a
   * previous definition, a conflict is recorded.
   *
   * @param def - The definition object to collect.
   * @param name - An optional name for the definition, if the name is different
   * than `def.name` (i.e. in import-like statements).
   * @param source - An optional source identifier for the definition, if the
   * source is different than `def.id` (i.e. in import-like statements).
   */
  collectDefinition(def: LookupDefinition, importedFrom?: QuintImport | QuintExport | QuintInstance): void {
    const identifier = (importedFrom as QuintImport)?.defName ?? def.name
    const source = importedFrom?.id ?? def.id
    if (identifier === '_') {
      // Don't collect underscores, as they are special identifiers that allow no usage
      return
    }

    if (builtinNames.includes(identifier)) {
      // Conflict with a built-in name
      this.recordConflict(identifier, undefined, source)
      return
    }

    if (this.definitionsByName.has(identifier) && this.definitionsByName.get(identifier)!.id != def.id) {
      // Conflict with a previous definition
      this.recordConflict(identifier, this.definitionsByName.get(identifier)!.id, source)
      return
    }

    const namespaces = importedFrom ? this.namespaces(importedFrom) : []
    this.definitionsByName.set(identifier, { ...addNamespacesToDef(def, namespaces), importedFrom })
  }

  /**
   * Deletes the definition with the given identifier from the collected definitions.
   *
   * @param identifier - The identifier of the definition to delete.
   */
  deleteDefinition(identifier: string): void {
    this.definitionsByName.delete(identifier)
  }

  /**
   * Obtains a collected definition.
   *
   * @param identifier - The identifier of the definition to retrieve.
   *
   * @returns The definition object for the given identifier, or undefined if a
   * definitions with that identifier was never collected.
   */
  getDefinition(identifier: string): LookupDefinition | undefined {
    return this.definitionsByName.get(identifier)
  }

  private namespaces(decl: QuintImport | QuintInstance | QuintExport): string[] {
    if (decl.kind === 'instance') {
      return compact([decl.qualifiedName ?? decl.protoName, this.currentModuleName])
    }

    const namespace = qualifier(decl)
    return namespace ? [namespace] : []
  }

  private collectDefinitions(
    newDefs: DefinitionsByName,
    importedFrom?: QuintImport | QuintExport | QuintInstance
  ): void {
    const namespaces = importedFrom ? this.namespaces(importedFrom) : []
    const newEntries: [string, LookupDefinition][] = [...newDefs.entries()].map(([identifier, def]) => {
      const existingEntry = this.definitionsByName.get(identifier)
      if (existingEntry && existingEntry.id !== def.id) {
        this.recordConflict(identifier, existingEntry.id, def.id)
      }
      return [identifier, { ...addNamespacesToDef(def, namespaces), importedFrom }]
    })

    this.definitionsByName = new Map([...this.definitionsByName.entries(), ...newEntries])
  }

  private recordConflict(identifier: string, exisitingSource: bigint | undefined, newSource: bigint): void {
    // exisitingSource is undefined when the conflict is with a built-in name
    const message = exisitingSource
      ? `Conflicting definitions found for name '${identifier}' in module '${this.currentModuleName}'`
      : `Built-in name '${identifier}' is redefined in module '${this.currentModuleName}'`

    if (exisitingSource) {
      this.errors.push({ code: 'QNT101', message, reference: exisitingSource, data: {} })
    }

    this.errors.push({ code: 'QNT101', message, reference: newSource, data: {} })
  }
}
